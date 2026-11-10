import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Approver,
  createPolicyGate,
  createScriptedApprover,
  createTerminalApprover,
  type GateEvent,
  type PolicyGate,
} from "@desktop-agent/adapter-agent-sdk";
import { decide } from "@desktop-agent/policy-core";
import { dataDir, openVerifiedLog, toDecisionEntry } from "./audit.ts";
import { CoverageTracker } from "./coverage.ts";
import { formatGateEvent } from "./log.ts";
import { prepareSandbox, sandboxPromptNote, sandboxReadOnlyJudge } from "./sandbox.ts";

const TOOLS = ["Bash", "Read", "Glob", "Grep"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sandbox: { type: "boolean", default: false },
    "scripted-approver": { type: "boolean", default: false },
  },
});

interface Setup {
  cwd: string;
  approver: Approver;
  append?: string;
}

async function setup(): Promise<Setup> {
  if (!values.sandbox) return { cwd: process.cwd(), approver: createTerminalApprover() };
  const sandbox = await prepareSandbox();
  const approver = values["scripted-approver"]
    ? createScriptedApprover(sandboxReadOnlyJudge(sandbox))
    : createTerminalApprover();
  return { cwd: sandbox.root, approver, append: sandboxPromptNote(sandbox) };
}

function buildOptions(cwd: string, gate: PolicyGate, append?: string): Options {
  return {
    cwd,
    tools: TOOLS,
    settingSources: [], // 사용자·프로젝트 설정(허용 규칙, 훅)을 섞지 않는다
    permissionMode: "default",
    hooks: gate.hooks,
    canUseTool: gate.canUseTool,
    maxTurns: 20,
    systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
  };
}

function printText(message: SDKMessage): void {
  if (message.type !== "assistant") return;
  for (const block of message.message.content) {
    if (block.type === "text") process.stdout.write(`${block.text}\n`);
  }
}

function reportResult(message: SDKResultMessage): boolean {
  const cost = message.total_cost_usd.toFixed(4);
  const models = Object.keys(message.modelUsage).join(",");
  process.stderr.write(
    `[agent] result=${message.subtype} turns=${message.num_turns} models=${models} cost=$${cost}\n`,
  );
  return message.subtype === "success";
}

function printCoverage(coverage: CoverageTracker): boolean {
  const { total, bash, missing } = coverage.report();
  process.stderr.write(
    `[coverage] 도구 호출 ${total}건 (Bash ${bash}건), decide() 미경유 ${missing.length}건\n`,
  );
  return missing.length === 0;
}

const logLine = (line: string) => process.stderr.write(`${line}\n`);

async function run(prompt: string): Promise<number> {
  const { cwd, approver, append } = await setup();
  const audit = openVerifiedLog(dataDir(values.sandbox), logLine);
  const requestId = randomUUID();
  audit.append({ kind: "request", requestId, prompt });
  const coverage = new CoverageTracker();
  const onEvent = (e: GateEvent) => {
    audit.append(toDecisionEntry(requestId, e));
    coverage.recordGate(e);
    logLine(formatGateEvent(e));
  };
  const gate = createPolicyGate({ decide, approver, onEvent });
  logLine(`[agent] cwd=${cwd}`);
  let ok = false;
  try {
    for await (const message of query({ prompt, options: buildOptions(cwd, gate, append) })) {
      coverage.recordMessage(message);
      printText(message);
      if (message.type === "result") ok = reportResult(message);
    }
  } finally {
    audit.close();
  }
  return printCoverage(coverage) && ok ? 0 : 1;
}

const prompt = positionals.join(" ").trim();
if (!prompt) {
  process.stderr.write('사용법: pnpm --filter cli dev [--sandbox] [--scripted-approver] "요청"\n');
  process.exit(2);
}
run(prompt).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[agent] 실패: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);

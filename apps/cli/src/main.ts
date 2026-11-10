import { parseArgs } from "node:util";
import {
  type McpSdkServerConfigWithInstance,
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AGENT_SERVER,
  type Approver,
  createScriptedApprover,
  createTerminalApprover,
  type PolicyGate,
} from "@desktop-agent/adapter-agent-sdk";
import { ready } from "@desktop-agent/policy-core";
import { dataDir } from "./audit.ts";
import type { CoverageTracker } from "./coverage.ts";
import { createRuntime } from "./runtime.ts";
import {
  prepareSandbox,
  SANDBOX_JUDGE_ID,
  sandboxPromptNote,
  sandboxReadOnlyJudge,
} from "./sandbox.ts";

/** 내장 도구는 모두 끈다. 파일·셸은 출력이 프라이버시 필터를 거치는 자체 MCP 도구로만 한다 */
const BUILTIN_TOOLS: string[] = [];

const TOOL_NOTE =
  "파일과 셸 작업에는 mcp__agent__ 도구(shell, read_file, write_file, edit_file, list_files)만 쓸 수 있다. " +
  "도구 결과의 [MASKED:종류]는 시크릿을 가린 자리이고, [전송 안 함]은 로컬에서만 다뤄야 하는 내용이다. 가려진 값을 추측하거나 우회해 읽으려 하지 않는다.";

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
    ? createScriptedApprover(SANDBOX_JUDGE_ID, sandboxReadOnlyJudge(sandbox))
    : createTerminalApprover();
  return { cwd: sandbox.root, approver, append: sandboxPromptNote(sandbox) };
}

function buildOptions(
  cwd: string,
  gate: PolicyGate,
  server: McpSdkServerConfigWithInstance,
  append?: string,
): Options {
  const promptAppend = [TOOL_NOTE, append].filter(Boolean).join("\n");
  return {
    cwd,
    tools: BUILTIN_TOOLS,
    mcpServers: { [AGENT_SERVER]: server },
    settingSources: [], // 사용자·프로젝트 설정(허용 규칙, 훅, MCP 서버)을 섞지 않는다
    permissionMode: "default",
    hooks: gate.hooks,
    canUseTool: gate.canUseTool,
    maxTurns: 20,
    systemPrompt: { type: "preset", preset: "claude_code", append: promptAppend },
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
  const { total, shell, ungated, unfiltered } = coverage.report();
  process.stderr.write(
    `[coverage] 도구 호출 ${total}건 (셸 ${shell}건), decide() 미경유 ${ungated.length}건, ` +
      `필터 미경유 ${unfiltered.length}건\n`,
  );
  return ungated.length === 0 && unfiltered.length === 0;
}

const logLine = (line: string) => process.stderr.write(`${line}\n`);

async function run(prompt: string): Promise<number> {
  await ready(); // 규칙·파서 로드. 실패하면 에이전트를 시작하지 않는다
  const { cwd, approver, append } = await setup();
  const rt = createRuntime({
    prompt,
    cwd,
    dataDir: dataDir(values.sandbox),
    approver,
    log: logLine,
  });
  logLine(`[agent] cwd=${cwd}`);
  try {
    const ok = await consume(prompt, buildOptions(cwd, rt.gate, rt.server, append), rt.coverage);
    return printCoverage(rt.coverage) && ok ? 0 : 1;
  } finally {
    rt.gate.endUserRequest();
    rt.audit.close();
  }
}

/** 에이전트 루프를 끝까지 돌리고 성공 여부를 돌려준다 */
async function consume(prompt: string, options: Options, coverage: CoverageTracker) {
  let ok = false;
  for await (const message of query({ prompt, options })) {
    coverage.recordMessage(message);
    printText(message);
    if (message.type === "result") ok = reportResult(message);
  }
  return ok;
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

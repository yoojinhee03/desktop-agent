import { parseArgs } from "node:util";
import {
  type Approver,
  createScriptedApprover,
  createTerminalApprover,
} from "@desktop-agent/adapter-agent-sdk";
import { runAgent } from "./agent.ts";
import { dataDir } from "./audit.ts";
import type { CoverageReport } from "./coverage.ts";
import {
  prepareSandbox,
  SANDBOX_JUDGE_ID,
  sandboxPromptNote,
  sandboxReadOnlyJudge,
} from "./sandbox.ts";

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

function printCoverage({ total, shell, ungated, unfiltered }: CoverageReport): boolean {
  process.stderr.write(
    `[coverage] 도구 호출 ${total}건 (셸 ${shell}건), decide() 미경유 ${ungated.length}건, ` +
      `필터 미경유 ${unfiltered.length}건\n`,
  );
  return ungated.length === 0 && unfiltered.length === 0;
}

const logLine = (line: string) => process.stderr.write(`${line}\n`);

async function run(prompt: string): Promise<number> {
  const { cwd, approver, append } = await setup();
  const result = await runAgent({
    prompt,
    cwd,
    dataDir: dataDir(values.sandbox),
    approver,
    ...(append ? { append } : {}),
    log: logLine,
    onText: (text) => process.stdout.write(`${text}\n`),
  });
  return printCoverage(result.coverage) && result.ok ? 0 : 1;
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

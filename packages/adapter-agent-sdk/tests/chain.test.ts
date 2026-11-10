// 전체 경로: PreToolUse 게이트(실제 정책 엔진) → 승인 장부 → 자체 MCP 도구 → 프라이버시 필터.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, nodeFs, ready } from "@desktop-agent/policy-core";
import { RuleBasedFilter, WITHHELD_NOTICE } from "@desktop-agent/privacy-filter";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalLedger,
  agentSchemaKeys,
  agentToolName,
  createAgentTools,
  createPolicyGate,
  createScriptedApprover,
} from "../src/index.ts";
import { callHook, preToolUse } from "./helpers.ts";

const AWS_REGION_LINE = "region = ap-northeast-2";

let home: string;
let ledger: ApprovalLedger;

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chain-home-"));
  mkdirSync(join(home, ".aws"));
  writeFileSync(join(home, ".aws", "credentials"), `[default]\n${AWS_REGION_LINE}\n`);
  mkdirSync(join(home, "Downloads"));
  writeFileSync(join(home, "Downloads", "a.pdf"), "%PDF-1.4\n");
  ledger = new ApprovalLedger(agentSchemaKeys);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function setup() {
  const gate = createPolicyGate({
    decide,
    context: { home, cwd: home, fs: nodeFs, agentPaths: [] },
    approver: createScriptedApprover("chain", () => "approved"),
    ledger,
  });
  const tools = createAgentTools({ cwd: home, home, ledger, filter: new RuleBasedFilter() });
  return { gate, tools: Object.fromEntries(tools.map((t) => [t.name, t])) };
}

/** 모델이 도구를 부르는 순서 그대로: 훅 판정 → (허용되면) 도구 실행 */
async function agentCall(name: string, args: Record<string, unknown>) {
  const { gate, tools } = setup();
  const hook = await callHook(gate, preToolUse(agentToolName(name as never), args));
  const t = tools[name];
  if (!t) throw new Error(`도구 없음: ${name}`);
  const result = await t.handler((hook.updatedInput ?? args) as never, {});
  const first = result.content[0];
  return { hook, text: first?.type === "text" ? first.text : "", isError: result.isError === true };
}

describe("게이트 → 장부 → 도구 → 필터", () => {
  it("자격증명 파일을 read_file로 읽어도 원문은 나가지 않는다", async () => {
    const out = await agentCall("read_file", { path: "~/.aws/credentials" });
    expect(out.hook.permissionDecision).toBe("allow");
    expect(out.text).toBe(WITHHELD_NOTICE);
  });

  it("셸 cat으로 자격증명을 읽어도 원문은 나가지 않는다", async () => {
    const out = await agentCall("shell", { command: "cat ~/.aws/credentials" });
    expect(out.text).not.toContain(AWS_REGION_LINE);
  });

  it("차단된 호출은 도구에 직접 들어와도 실행되지 않는다", async () => {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY-BODY\n");
    const out = await agentCall("shell", { command: "cat ~/.ssh/id_rsa" });
    expect(out.hook.permissionDecision).toBe("deny");
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("PRIVATE-KEY-BODY");
  });

  it("휴지통으로 치환된 뒤 원래 rm 명령은 장부에 없다", async () => {
    const { gate } = setup();
    const hook = await callHook(
      gate,
      preToolUse(agentToolName("shell"), { command: "rm ~/Downloads/a.pdf" }),
    );
    expect(String(hook.updatedInput?.command)).toContain("trash");
    expect(ledger.take(agentToolName("shell"), { command: "rm ~/Downloads/a.pdf" })).toBeNull();
  });
});

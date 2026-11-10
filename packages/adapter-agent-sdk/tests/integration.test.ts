// 실제 정책 엔진(policy-core)과 게이트를 함께 돌린다. 명령은 실행하지 않고 판정·세션 상태만 본다.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, nodeFs, ready } from "@desktop-agent/policy-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPolicyGate, createScriptedApprover, type GateEvent } from "../src/index.ts";
import { callHook, preToolUse } from "./helpers.ts";

let home: string;
let asked: number;
let events: GateEvent[];

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gate-it-home-"));
  mkdirSync(join(home, "Downloads"));
  writeFileSync(join(home, "Downloads", "a.pdf"), "%PDF-1.4\n");
  asked = 0;
  events = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function makeGate(answer: "approved" | "approved_for_session" | "rejected" = "approved") {
  return createPolicyGate({
    decide,
    context: { home, cwd: home, fs: nodeFs, agentPaths: [] },
    approver: createScriptedApprover("it", () => {
      asked += 1;
      return answer;
    }),
    onEvent: (e) => {
      events.push(e);
    },
  });
}

const bash = (command: string, id = "tu") => preToolUse("Bash", { command }, id);

describe("실제 정책 엔진 연결", () => {
  it("읽기 명령은 묻지 않고 자동 실행 (0등급)", async () => {
    const out = await callHook(makeGate(), bash("mdfind -name 견적서"));
    expect(out.permissionDecision).toBe("allow");
    expect(events[0]).toMatchObject({ outcome: "auto_allowed", decision: { grade: 0 } });
    expect(asked).toBe(0);
  });

  it("rm은 휴지통 이동으로 치환해 실행", async () => {
    const out = await callHook(makeGate(), bash("rm ~/Downloads/a.pdf"));
    expect(out.permissionDecision).toBe("allow");
    expect(events[0]?.outcome).toBe("rewritten");
    expect(String(out.updatedInput?.command)).toContain("trash");
  });

  it("차단 명령은 승인을 묻지 않고 거부", async () => {
    const out = await callHook(makeGate(), bash("csrutil disable"));
    expect(out.permissionDecision).toBe("deny");
    expect(events[0]?.decision?.grade).toBe("block");
    expect(asked).toBe(0);
  });

  it("bash -c 안의 개인키 읽기도 차단", async () => {
    const out = await callHook(makeGate(), bash('bash -c "cat ~/.ssh/id_rsa"'));
    expect(out.permissionDecision).toBe("deny");
  });

  it("세션 허용 후 같은 종류의 두 번째 호출은 자동 실행", async () => {
    const gate = makeGate("approved_for_session");
    await callHook(gate, bash("brew install jq", "t1"));
    const second = await callHook(gate, bash("brew install jq", "t2"));
    expect(asked).toBe(1);
    expect(second.permissionDecision).toBe("allow");
    expect(events[1]?.outcome).toBe("auto_allowed");
  });

  it("웹 도구를 쓴 뒤의 2등급 작업에는 외부 콘텐츠 표시가 붙는다", async () => {
    const gate = makeGate();
    await callHook(gate, preToolUse("WebFetch", { url: "https://example.com" }, "t1"));
    await callHook(gate, bash("brew install jq", "t2"));
    expect(events[1]?.decision?.flags).toContain("after_external_content");
  });

  it("에이전트가 쓴 스크립트를 실행하면 내용까지 판정한다", async () => {
    const gate = makeGate();
    const script = join(home, "cleanup.sh");
    await callHook(gate, preToolUse("Write", { file_path: script, content: "rm -rf ~\n" }, "t1"));
    expect(gate.session().writtenFiles).toContain(script);
    writeFileSync(script, "rm -rf ~\n"); // 승인된 쓰기가 실제로 실행된 상태를 흉내 낸다
    const out = await callHook(gate, bash(`bash ${script}`, "t2"));
    expect(out.permissionDecision).toBe("deny");
    expect(events[1]?.decision?.grade).toBe("block");
  });
});

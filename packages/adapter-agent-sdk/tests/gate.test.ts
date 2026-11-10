import type { PolicyDecision } from "@desktop-agent/policy-core";
import { describe, expect, it } from "vitest";
import {
  type ApprovalAnswer,
  createPolicyGate,
  createScriptedApprover,
  type GateEvent,
} from "../src/index.ts";
import { baseContext, callHook, preToolUse } from "./helpers.ts";

const base: PolicyDecision = {
  grade: 2,
  action: "ask",
  ruleIds: ["t"],
  reasons: ["r"],
  flags: [],
};

function makeGate(decision: PolicyDecision | Error, answer: ApprovalAnswer = "approved") {
  const events: GateEvent[] = [];
  const gate = createPolicyGate({
    decide: () => {
      if (decision instanceof Error) throw decision;
      return decision;
    },
    context: baseContext(),
    approver: createScriptedApprover("test", () => answer),
    onEvent: (e) => {
      events.push(e);
    },
  });
  return { gate, events };
}

async function run(decision: PolicyDecision | Error, answer: ApprovalAnswer = "approved") {
  const { gate, events } = makeGate(decision, answer);
  const specific = await callHook(gate, preToolUse("Bash", { command: "ls" }));
  return { specific, events, gate };
}

describe("판정 처리", () => {
  it("ask + 승인이면 allow, 승인자 id를 남긴다", async () => {
    const { specific, events } = await run(base, "approved");
    expect(specific.permissionDecision).toBe("allow");
    expect(events[0]).toMatchObject({ outcome: "approved", decidedBy: "script:test" });
    expect(events[0]?.call).toEqual({ toolName: "Bash", input: { command: "ls" } });
  });

  it("ask + 거절이면 deny", async () => {
    const { specific } = await run(base, "rejected");
    expect(specific.permissionDecision).toBe("deny");
  });

  it("deny 판정은 승인을 묻지 않고 거부", async () => {
    const { specific, events } = await run({ ...base, grade: "block", action: "deny" });
    expect(specific.permissionDecision).toBe("deny");
    expect(events[0]).toMatchObject({ outcome: "denied", decidedBy: "policy" });
  });

  it("rewrite는 치환된 명령으로 실행", async () => {
    const { specific } = await run({ ...base, grade: 1, action: "rewrite", rewrite: "trash a" });
    expect(specific.permissionDecision).toBe("allow");
    expect(specific.updatedInput).toEqual({ command: "trash a" });
  });

  it("rewrite 명령이 비어 있으면 원래 명령을 실행하지 않음", async () => {
    const { specific } = await run({ ...base, grade: 1, action: "rewrite" });
    expect(specific.permissionDecision).toBe("deny");
  });

  it("decide()가 예외를 던지면 거부 (fail closed)", async () => {
    const { specific, events } = await run(new Error("규칙 로드 실패"));
    expect(specific.permissionDecision).toBe("deny");
    expect(events[0]?.outcome).toBe("error");
  });

  it("canUseTool 안전망은 항상 거부", async () => {
    const { gate } = makeGate(base);
    const result = await gate.canUseTool("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "x",
    } as never);
    expect(result?.behavior).toBe("deny");
  });
});

describe("세션 상태", () => {
  const sessionable: PolicyDecision = { ...base, allowKeys: ["cmd.brew.install"] };

  it("세션 허용을 고르면 allowKeys가 세션에 쌓인다", async () => {
    const { gate } = await run(sessionable, "approved_for_session");
    expect(gate.session().allowKeys).toEqual(["cmd.brew.install"]);
  });

  it("실행된 호출의 작성 파일·오염 경로를 기록한다", async () => {
    const effects = { writes: ["/tmp/cleanup.sh"], tainted: ["/tmp/copy"] };
    const { gate } = await run({ ...base, effects }, "approved");
    expect(gate.session()).toMatchObject({
      writtenFiles: ["/tmp/cleanup.sh"],
      taintedFiles: ["/tmp/copy"],
    });
  });

  it("거절된 호출은 기록하지 않는다", async () => {
    const effects = { writes: ["/tmp/cleanup.sh"], tainted: [] };
    const { gate } = await run({ ...base, effects }, "rejected");
    expect(gate.session().writtenFiles).toEqual([]);
  });

  it("웹 도구를 쓰면 외부 콘텐츠 표시, 요청이 끝나면 내린다", async () => {
    const web: PolicyDecision = { ...base, grade: 0, action: "allow", ruleIds: ["tool.web"] };
    const { gate } = await run(web);
    expect(gate.session().externalContent).toBe(true);
    gate.endUserRequest();
    expect(gate.session().externalContent).toBe(false);
  });

  it("판정마다 최신 세션 상태를 decide()에 넘긴다", async () => {
    const seen: string[][] = [];
    const gate = createPolicyGate({
      decide: (_call, ctx) => {
        seen.push(ctx.session.writtenFiles);
        return { ...base, effects: { writes: [`/tmp/f${seen.length}`], tainted: [] } };
      },
      context: baseContext(),
      approver: createScriptedApprover("test", () => "approved"),
    });
    await callHook(gate, preToolUse("Bash", { command: "a" }, "t1"));
    await callHook(gate, preToolUse("Bash", { command: "b" }, "t2"));
    expect(seen).toEqual([[], ["/tmp/f1"]]);
  });

  it("동시에 들어온 호출의 승인을 겹치지 않게 하나씩 처리한다", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = createPolicyGate({
      decide: () => base,
      context: baseContext(),
      approver: {
        id: "slow",
        ask: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return "approved";
        },
      },
    });
    await Promise.all(
      ["t1", "t2", "t3"].map((id) => callHook(gate, preToolUse("Bash", { command: id }, id))),
    );
    expect(maxActive).toBe(1);
  });
});

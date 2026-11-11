import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";
import { describe, expect, it } from "vitest";
import { toDecisionEntry } from "../src/audit.ts";

// 가짜 값은 실행할 때 조립한다 (privacy-filter 테스트셋과 같은 이유)
const fakeKey = `gh${"p"}_${"A7b2C9d4E1".repeat(4).slice(0, 36)}`;

function event(over: Partial<GateEvent>): GateEvent {
  return {
    toolUseId: "tu_1",
    call: { toolName: "Bash", input: { command: "rm a" } },
    decision: { grade: 2, action: "ask", ruleIds: ["cmd.rm"], reasons: ["삭제"], flags: [] },
    outcome: "approved",
    decidedBy: "user:terminal",
    executedInput: { command: "rm a" },
    ...over,
  };
}

describe("toDecisionEntry", () => {
  it("수정 요청 문구를 시크릿을 가린 뒤 남긴다", () => {
    const entry = toDecisionEntry(
      "r1",
      event({
        outcome: "revision_requested",
        executedInput: null,
        feedback: `토큰 ${fakeKey} 말고 다른 걸로`,
      }),
    );
    expect(entry.outcome).toBe("revision_requested");
    expect(entry.feedback).toContain("[MASKED:");
    expect(JSON.stringify(entry)).not.toContain(fakeKey);
  });

  it("정책 엔진 preview.diff의 시크릿도 가린다", () => {
    const decision = {
      grade: 2 as const,
      action: "ask" as const,
      ruleIds: ["t"],
      reasons: [],
      flags: [],
      preview: { paths: ["/x"], diff: `+TOKEN=${fakeKey}` },
    };
    const entry = toDecisionEntry("r1", event({ decision }));
    expect(entry.preview?.paths).toEqual(["/x"]);
    expect(JSON.stringify(entry)).not.toContain(fakeKey);
  });

  it("수정 요청이 아니면 feedback 필드가 없다", () => {
    expect(toDecisionEntry("r1", event({}))).not.toHaveProperty("feedback");
  });
});

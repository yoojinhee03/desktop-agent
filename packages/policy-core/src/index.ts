import type { PolicyDecision, ToolCall } from "./types.ts";

export type * from "./types.ts";

/**
 * 임시 구현: 모든 호출을 2등급 ask로 돌려준다.
 * 규칙 엔진은 세션 B가 이 자리를 채운다. 순수 함수(입력 → PolicyDecision)를 유지한다.
 */
export function decide(_call: ToolCall): PolicyDecision {
  return {
    grade: 2,
    action: "ask",
    ruleIds: ["stub.unclassified"],
    reasons: ["임시 구현: 모든 명령을 미분류(2등급)로 처리"],
    flags: [],
  };
}

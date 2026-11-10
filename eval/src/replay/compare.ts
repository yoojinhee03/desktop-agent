// 기록된 판정과 다시 한 판정을 비교해 변화 종류를 정한다.
import type { DecisionEntry } from "@desktop-agent/audit-log";
import type { Grade, PolicyDecision } from "@desktop-agent/policy-core";

/**
 * same: 등급·처리·규칙이 같음
 * stricter: 등급이 올라감 (더 많이 묻거나 막음)
 * looser: 등급이 내려감 — 정책 변경의 회귀 신호 (차단을 느슨하게 하는 변경은 결정 로그에 남긴다)
 * changed: 등급은 같고 처리 방식이나 근거 규칙이 바뀜
 * error: 다시 판정하다 오류
 */
export type ChangeKind = "same" | "stricter" | "looser" | "changed" | "error";

export interface CallDiff {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  before: { grade: Grade | null; action: string | null; ruleIds: string[] };
  after: { grade: Grade; action: string; ruleIds: string[] } | null;
  kind: ChangeKind;
  error?: string;
}

const RANK: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, block: 4 };

/** 기록 당시 판정이 실패했으면(null) 가장 엄격한 쪽(거부)으로 본다 */
function rank(grade: Grade | null): number {
  return grade === null ? 4 : (RANK[String(grade)] ?? 4);
}

function sameRules(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export function classify(before: DecisionEntry, after: PolicyDecision): ChangeKind {
  const diff = rank(after.grade) - rank(before.grade);
  if (diff > 0) return "stricter";
  if (diff < 0) return "looser";
  const same = before.action === after.action && sameRules(before.ruleIds, after.ruleIds);
  return same ? "same" : "changed";
}

export function toDiff(call: DecisionEntry, after: PolicyDecision | Error): CallDiff {
  const base = {
    requestId: call.requestId,
    toolUseId: call.toolUseId,
    toolName: call.toolName,
    input: call.input,
    before: { grade: call.grade, action: call.action, ruleIds: call.ruleIds },
  };
  if (after instanceof Error) return { ...base, after: null, kind: "error", error: after.message };
  const next = { grade: after.grade, action: after.action, ruleIds: after.ruleIds };
  return { ...base, after: next, kind: classify(call, after) };
}

// 지표 (테스트: 평가 하네스와 레드팀 > 지표): 작업 성공률, 요청당 승인 횟수, 비용·턴 수.
import type { ScenarioResult } from "./run-scenario.ts";

export interface Summary {
  total: number;
  passed: number;
  successRate: number;
  avgApprovals: number;
  totalCostUsd: number;
  avgTurns: number;
}

export function summarize(results: ScenarioResult[]): Summary {
  const total = results.length;
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const avg = (f: (r: ScenarioResult) => number) => (total === 0 ? 0 : sum(f) / total);
  const passed = results.filter((r) => r.passed).length;
  return {
    total,
    passed,
    successRate: total === 0 ? 0 : passed / total,
    avgApprovals: avg((r) => r.approvals),
    totalCostUsd: sum((r) => r.costUsd),
    avgTurns: avg((r) => r.turns),
  };
}

export function formatResult(r: ScenarioResult): string[] {
  const head = `${r.passed ? "PASS" : "FAIL"} ${r.id} — ${r.title} (승인 ${r.approvals}회, ${r.turns}턴, $${r.costUsd.toFixed(3)})`;
  const failed = r.checks
    .filter((c) => !c.ok)
    .map((c) => `    ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  return [head, ...failed];
}

export function formatSummary(s: Summary): string {
  const rate = (s.successRate * 100).toFixed(0);
  return (
    `성공 ${s.passed}/${s.total} (${rate}%) · 요청당 승인 평균 ${s.avgApprovals.toFixed(2)}회 · ` +
    `평균 ${s.avgTurns.toFixed(1)}턴 · 비용 합계 $${s.totalCostUsd.toFixed(3)}`
  );
}

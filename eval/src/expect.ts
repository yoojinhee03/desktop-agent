// 판정·승인 기록으로 기대 동작을 확인한다 (승인 횟수, 실제 실행된 명령, 처리 결과, 커버리지).
import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";
import type { ApprovalRecord } from "./approver.ts";
import type { CheckResult } from "./checks.ts";
import type { Scenario } from "./schema.ts";

export interface RunRecord {
  events: GateEvent[];
  approvals: ApprovalRecord[];
  agentOk: boolean;
  ungated: number;
  unfiltered: number;
}

const SHELL_TOOL = /(^Bash$|__shell$)/;

/** 실제로 실행된(허용·치환된) 셸 명령 */
export function executedCommands(events: GateEvent[]): string[] {
  return events
    .filter((e) => SHELL_TOOL.test(e.call.toolName) && e.executedInput !== null)
    .map((e) => e.executedInput?.command)
    .filter((c): c is string => typeof c === "string");
}

function approvalChecks(s: Scenario, r: RunRecord): CheckResult[] {
  const n = r.approvals.length;
  const { min_approvals: min, max_approvals: max } = s.expect;
  const approved = r.approvals.filter((a) => a.answer !== "rejected").flatMap((a) => a.ruleIds);
  return [
    { name: `승인 요청 ${min}~${max}회`, ok: n >= min && n <= max, detail: `실제 ${n}회` },
    ...s.expect.approved_rules.map((rule) => ({
      name: `승인된 규칙: ${rule}`,
      ok: approved.includes(rule),
      detail: "",
    })),
  ];
}

function commandChecks(s: Scenario, r: RunRecord): CheckResult[] {
  const cmds = executedCommands(r.events);
  const include = s.expect.executed_include.map((re) => ({
    name: `실행된 명령에 /${re}/`,
    ok: cmds.some((c) => new RegExp(re).test(c)),
    detail: "",
  }));
  const exclude = s.expect.executed_exclude.map((re) => {
    const hit = cmds.find((c) => new RegExp(re).test(c));
    return { name: `실행되면 안 됨 /${re}/`, ok: hit === undefined, detail: hit ?? "" };
  });
  return [...include, ...exclude];
}

function outcomeChecks(s: Scenario, r: RunRecord): CheckResult[] {
  const outcomes = new Set<string>(r.events.map((e) => e.outcome));
  return s.expect.outcomes_include.map((o) => ({
    name: `처리 결과 ${o}`,
    ok: outcomes.has(o),
    detail: "",
  }));
}

function runChecksOf(r: RunRecord): CheckResult[] {
  return [
    { name: "에이전트 성공 종료", ok: r.agentOk, detail: "" },
    { name: "decide() 미경유 0건", ok: r.ungated === 0, detail: `${r.ungated}건` },
    { name: "필터 미경유 0건", ok: r.unfiltered === 0, detail: `${r.unfiltered}건` },
  ];
}

export function evaluateExpect(s: Scenario, r: RunRecord): CheckResult[] {
  return [
    ...runChecksOf(r),
    ...approvalChecks(s, r),
    ...outcomeChecks(s, r),
    ...commandChecks(s, r),
  ];
}

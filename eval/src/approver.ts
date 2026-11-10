import type { ApprovalAnswer, Approver } from "@desktop-agent/adapter-agent-sdk";
import type { PolicyDecision, ToolCall } from "@desktop-agent/policy-core";

export interface ApprovalRecord {
  toolName: string;
  ruleIds: string[];
  grade: PolicyDecision["grade"];
  answer: ApprovalAnswer;
}

/**
 * 시나리오용 승인자: 승인 요청에 허용 규칙이 하나라도 있으면 승인, 아니면 거절.
 * 요청이 몇 번 왔는지(요청당 승인 횟수 지표)와 무엇을 승인·거절했는지 기록한다.
 */
export function createScenarioApprover(approveRules: readonly string[]) {
  const records: ApprovalRecord[] = [];
  const approver: Approver = {
    id: "script:scenario",
    async ask(call: ToolCall, d: PolicyDecision) {
      const ok = d.ruleIds.some((r) => approveRules.includes(r));
      const answer: ApprovalAnswer = ok ? "approved" : "rejected";
      records.push({ toolName: call.toolName, ruleIds: d.ruleIds, grade: d.grade, answer });
      return answer;
    },
  };
  return { approver, records };
}

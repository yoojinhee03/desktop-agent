import { describeCall, type GateEvent } from "@desktop-agent/adapter-agent-sdk";

/** 판정 로그 한 줄: 모든 도구 호출이 decide()를 거쳤는지 눈으로 확인하는 용도. */
export function formatGateEvent(event: GateEvent): string {
  const d = event.decision;
  const verdict = d
    ? `grade=${d.grade} action=${d.action} rules=${d.ruleIds.join(",")}`
    : "decide() 실패";
  const rewrite = d?.rewrite ? ` rewrite=${JSON.stringify(d.rewrite)}` : "";
  const detail = event.error ? ` error=${event.error}` : "";
  const command = JSON.stringify(describeCall(event.call));
  const head = `[policy] ${event.toolUseId} ${event.call.toolName} ${command}`;
  return `${head} → ${verdict}${rewrite} → ${event.outcome} by=${event.decidedBy}${detail}`;
}

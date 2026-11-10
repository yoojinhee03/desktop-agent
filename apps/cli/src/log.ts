import { describeCall, type FilterEvent, type GateEvent } from "@desktop-agent/adapter-agent-sdk";

/** 필터가 무언가 했을 때만 한 줄 (마스킹·전송 보류·실행 거부). 원문은 찍지 않는다 */
export function formatFilterEvent(e: FilterEvent): string | null {
  const id = e.toolUseId ?? "-";
  if (e.refused) return `[filter] ${id} ${e.toolName} 실행 거부: ${e.refused}`;
  if (e.withheld) return `[filter] ${id} ${e.toolName} 전송 보류 (${e.withheld})`;
  if (e.maskings.length === 0) return null;
  const kinds = e.maskings.map((m) => `${m.kind}×${m.count}`).join(", ");
  return `[filter] ${id} ${e.toolName} 마스킹 ${kinds}`;
}

/** 판정 로그 한 줄: 모든 도구 호출이 decide()를 거쳤는지 눈으로 확인하는 용도. */
export function formatGateEvent(event: GateEvent): string {
  const d = event.decision;
  const verdict = d
    ? `grade=${d.grade} action=${d.action} rules=${d.ruleIds.join(",")}`
    : "decide() 실패";
  const rewrite = d?.rewrite ? ` rewrite=${JSON.stringify(d.rewrite)}` : "";
  const flags = d && d.flags.length > 0 ? ` flags=${d.flags.join(",")}` : "";
  const detail = `${flags}${event.error ? ` error=${event.error}` : ""}`;
  const command = JSON.stringify(describeCall(event.call));
  const head = `[policy] ${event.toolUseId} ${event.call.toolName} ${command}`;
  return `${head} → ${verdict}${rewrite} → ${event.outcome} by=${event.decidedBy}${detail}`;
}

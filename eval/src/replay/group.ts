// 감사 로그 기록을 사용자 요청 단위로 묶는다 (재생은 요청마다 세션 상태를 처음부터 다시 쌓는다).
import type { DecisionEntry, RecordedEntry } from "@desktop-agent/audit-log";

export interface RecordedRequest {
  requestId: string;
  prompt: string;
  cwd?: string;
  home?: string;
  calls: DecisionEntry[];
}

function emptyRequest(requestId: string): RecordedRequest {
  return { requestId, prompt: "(요청 기록 없음)", calls: [] };
}

/** 기록 순서를 지키며 요청별로 묶는다. 요청 기록이 빠진 판정도 버리지 않는다 */
export function groupByRequest(entries: Iterable<RecordedEntry>): RecordedRequest[] {
  const byId = new Map<string, RecordedRequest>();
  const get = (id: string) => byId.get(id) ?? byId.set(id, emptyRequest(id)).get(id);
  for (const { entry } of entries) {
    if (entry.kind === "filter") continue;
    const req = get(entry.requestId);
    if (!req) continue;
    if (entry.kind === "decision") req.calls.push(entry);
    else Object.assign(req, { prompt: entry.prompt, cwd: entry.cwd, home: entry.home });
  }
  return [...byId.values()];
}

// 정책 재생 (테스트: 평가 하네스와 레드팀 > 세션 리플레이 > 정책 재생).
// 기록된 도구 호출을 지금(또는 후보) 정책 엔진에 다시 넣어 판정 변화만 비교한다. 모델 호출 없음.
import type { DecisionEntry } from "@desktop-agent/audit-log";
import {
  allowForSession,
  type DecideContext,
  emptySession,
  markExternalContent,
  type PolicyDecision,
  recordExecution,
  type SessionState,
  type ToolCall,
} from "@desktop-agent/policy-core";
import { type CallDiff, toDiff } from "./compare.ts";
import type { RecordedRequest } from "./group.ts";

export interface ReplayOptions {
  decide: (call: ToolCall, ctx: DecideContext) => PolicyDecision;
  /** 홈·작업 폴더 외의 판정 문맥 (파일 조회, 에이전트 내부 경로) */
  base: Pick<DecideContext, "fs" | "agentPaths">;
  /** 요청 기록에 홈·작업 폴더가 없을 때(이전 기록) 쓸 값 */
  fallbackHome: string;
  fallbackCwd: string;
}

const WEB = /(^|__)(web_?fetch|web_?search)$/i;

/**
 * 세션 상태는 "그때 실제로 일어난 일"로 쌓는다: 기록상 실행된 호출만 반영하고, 세션 허용은 기록된 승인을 따른다.
 * 작성 파일·오염 경로(effects)는 기록에 없어 새 판정의 것을 쓴다.
 */
function advance(
  session: SessionState,
  call: DecisionEntry,
  d: PolicyDecision | Error,
): SessionState {
  if (d instanceof Error || call.executedInput === null) return session;
  let next = recordExecution(session, d);
  if (call.outcome === "approved_for_session") next = allowForSession(next, d);
  if (WEB.test(call.toolName)) next = markExternalContent(next);
  return next;
}

function judge(o: ReplayOptions, call: DecisionEntry, ctx: DecideContext): PolicyDecision | Error {
  try {
    return o.decide({ toolName: call.toolName, input: call.input }, ctx);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

export function replayRequest(req: RecordedRequest, o: ReplayOptions): CallDiff[] {
  const home = req.home ?? o.fallbackHome;
  const cwd = req.cwd ?? o.fallbackCwd;
  let session = emptySession();
  const diffs: CallDiff[] = [];
  for (const call of req.calls) {
    const decision = judge(o, call, { ...o.base, home, cwd, session });
    diffs.push(toDiff(call, decision));
    session = advance(session, call, decision);
  }
  return diffs;
}

export function replayAll(requests: RecordedRequest[], o: ReplayOptions): CallDiff[] {
  return requests.flatMap((r) => replayRequest(r, o));
}

// 세션 상태 다루기. 모두 새 객체를 돌려준다(입력은 바꾸지 않음).
import type { PolicyDecision, SessionState } from "./types.ts";

export function emptySession(): SessionState {
  return { writtenFiles: [], taintedFiles: [], allowKeys: [], externalContent: false };
}

/** 승인·실행이 끝난 뒤 호출: 이번 호출이 쓴 파일과 오염 경로를 세션에 기록한다 */
export function recordExecution(s: SessionState, d: PolicyDecision): SessionState {
  return {
    ...s,
    writtenFiles: union(s.writtenFiles, d.effects?.writes ?? []),
    taintedFiles: union(s.taintedFiles, d.effects?.tainted ?? []),
  };
}

/** 승인 창에서 "이번 세션에서 같은 종류 허용"을 골랐을 때. 2등급 판정만 대상 */
export function allowForSession(s: SessionState, d: PolicyDecision): SessionState {
  if (d.grade !== 2 || !d.allowKeys) return s;
  return { ...s, allowKeys: union(s.allowKeys, d.allowKeys) };
}

/** 웹 페이지·다운로드 파일 등 외부 콘텐츠를 읽었을 때 (현재 사용자 요청이 끝날 때까지 유지) */
export function markExternalContent(s: SessionState): SessionState {
  return { ...s, externalContent: true };
}

export function endUserRequest(s: SessionState): SessionState {
  return { ...s, externalContent: false };
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

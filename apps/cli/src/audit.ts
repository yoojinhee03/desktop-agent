import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { FilterEvent, GateEvent } from "@desktop-agent/adapter-agent-sdk";
import {
  type AuditLog,
  type DecisionEntry,
  type FilterEntry,
  openAuditLog,
} from "@desktop-agent/audit-log";
import { maskDeep } from "@desktop-agent/privacy-filter";

/**
 * 감사 로그 위치: 에이전트 작업 폴더(cwd) 밖의 앱 전용 폴더.
 * 샌드박스 실행은 임시 폴더, 실제 실행은 ~/Library/Application Support/desktop-agent.
 */
export function dataDir(sandbox: boolean): string {
  const dir = sandbox
    ? join(tmpdir(), "desktop-agent-data")
    : join(homedir(), "Library", "Application Support", "desktop-agent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 정책 엔진에 넘길 에이전트 내부 경로(글로브). 이 폴더의 쓰기·삭제는 차단된다.
 * $TMPDIR는 /var/... 와 /private/var/... 두 표기가 있어 둘 다 넣는다.
 */
export function agentPathGlobs(dir: string): string[] {
  const forms = [...new Set([dir, realpathSync(dir)])];
  return forms.flatMap((d) => [d, `${d}/**`]);
}

/** 시작 시 해시 체인을 검증하고, 깨졌으면 어느 행부터인지 알린다. 기록은 계속한다. */
export function openVerifiedLog(dir: string, log: (line: string) => void): AuditLog {
  const audit = openAuditLog(join(dir, "audit.sqlite"));
  const result = audit.verify();
  if (result.ok) {
    log(`[audit] 해시 체인 검증 통과 (${result.rows}행) · ${dir}`);
  } else {
    log(`[audit] 경고: 해시 체인이 ${result.brokenAtId}번 행에서 깨짐 (${result.reason}) · ${dir}`);
  }
  return audit;
}

export function toFilterEntry(requestId: string, e: FilterEvent): FilterEntry {
  return {
    kind: "filter",
    requestId,
    toolUseId: e.toolUseId,
    toolName: e.toolName,
    maskings: e.maskings,
    withheld: e.withheld,
    ...(e.refused ? { refused: e.refused } : {}),
  };
}

/** 도구 입력(명령·파일 내용)도 시크릿을 가린 뒤에 남긴다: 감사 로그에 원문 시크릿을 저장하지 않는다 */
export function toDecisionEntry(requestId: string, event: GateEvent): DecisionEntry {
  const d = event.decision;
  return {
    kind: "decision",
    requestId,
    toolUseId: event.toolUseId,
    toolName: event.call.toolName,
    input: maskDeep(event.call.input),
    grade: d?.grade ?? null,
    action: d?.action ?? null,
    ruleIds: d?.ruleIds ?? [],
    reasons: d?.reasons ?? [],
    flags: d?.flags ?? [],
    ...(d?.preview ? { preview: d.preview } : {}),
    outcome: event.outcome,
    decidedBy: event.decidedBy,
    executedInput: event.executedInput && maskDeep(event.executedInput),
    ...(event.error ? { error: event.error } : {}),
  };
}

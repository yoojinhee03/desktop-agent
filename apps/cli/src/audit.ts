import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";
import { type AuditLog, type DecisionEntry, openAuditLog } from "@desktop-agent/audit-log";

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

export function toDecisionEntry(requestId: string, event: GateEvent): DecisionEntry {
  return {
    kind: "decision",
    requestId,
    toolUseId: event.toolUseId,
    toolName: event.call.toolName,
    input: event.call.input,
    grade: event.decision?.grade ?? null,
    action: event.decision?.action ?? null,
    ruleIds: event.decision?.ruleIds ?? [],
    outcome: event.outcome,
    executedInput: event.executedInput,
    ...(event.error ? { error: event.error } : {}),
  };
}

import type { Grade, PolicyAction } from "@desktop-agent/policy-core";

/** 사용자 요청 한 건 */
export interface RequestEntry {
  kind: "request";
  requestId: string;
  prompt: string;
}

/** 도구 호출 판정 한 건: 명령, 등급, 처리 방식, 승인 결과 */
export interface DecisionEntry {
  kind: "decision";
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  grade: Grade | null; // decide()가 실패하면 null
  action: PolicyAction | null;
  ruleIds: string[];
  outcome: string; // auto_allowed | approved | rejected | denied | rewritten | error
  executedInput: Record<string, unknown> | null;
  error?: string;
}

export type AuditEntry = RequestEntry | DecisionEntry;

/** 저장된 한 행. hash = sha256(prevHash + "\n" + canonical(entry + createdAt)) */
export interface StoredRow {
  id: number;
  createdAt: string;
  payload: string; // canonical JSON
  prevHash: string;
  hash: string;
}

export type VerifyResult =
  | { ok: true; rows: number }
  | { ok: false; rows: number; brokenAtId: number; reason: "prev_mismatch" | "hash_mismatch" };

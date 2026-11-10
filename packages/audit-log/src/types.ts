import type { ChangePreview, Grade, PolicyAction, PolicyFlag } from "@desktop-agent/policy-core";

/** 사용자 요청 한 건 */
export interface RequestEntry {
  kind: "request";
  requestId: string;
  prompt: string;
  /** 판정 환경 (정책 재생 때 같은 기준으로 다시 판정하기 위함). 이전 기록에는 없을 수 있다 */
  cwd?: string;
  home?: string;
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
  reasons: string[];
  flags: PolicyFlag[];
  /** 영향 범위(대상 경로·개수·크기). 휴지통 치환이면 원래 경로가 여기와 input에 남아 실행 취소에 쓴다 */
  preview?: ChangePreview;
  // auto_allowed | approved | approved_for_session | rejected | denied | rewritten | error
  outcome: string;
  /** 실행을 결정한 주체: policy 또는 승인자 id (user:terminal, script:…) */
  decidedBy: string;
  /** 실제 실행된 입력. rewrite면 치환된 명령, 거부면 null */
  executedInput: Record<string, unknown> | null;
  error?: string;
}

/** 프라이버시 필터 처리 한 건. 원문은 남기지 않고 마스킹 종류·개수와 전송 보류 여부만 남긴다 */
export interface FilterEntry {
  kind: "filter";
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  maskings: { kind: string; count: number }[];
  withheld: string | null;
  /** 승인 장부에 없어 도구가 실행을 거부했으면 그 이유 */
  refused?: string;
}

export type AuditEntry = RequestEntry | DecisionEntry | FilterEntry;

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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, canonicalJson, type DecisionEntry, openAuditLog } from "../src/index.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
  dbPath = join(dir, "audit.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const request: AuditEntry = { kind: "request", requestId: "r1", prompt: "PDF 찾아줘" };
const decision: DecisionEntry = {
  kind: "decision",
  requestId: "r1",
  toolUseId: "tu1",
  toolName: "Bash",
  input: { command: 'find . -name "*.pdf"' },
  grade: 2,
  action: "ask",
  ruleIds: ["stub.unclassified"],
  outcome: "approved",
  executedInput: { command: 'find . -name "*.pdf"' },
};

function seed(n: number): void {
  const log = openAuditLog(dbPath);
  log.append(request);
  for (let i = 1; i < n; i++) log.append({ ...decision, toolUseId: `tu${i}` });
  log.close();
}

function tamper(sql: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

describe("canonicalJson", () => {
  it("키 순서와 무관하게 같은 문자열", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("audit log 해시 체인", () => {
  it("정상 기록은 검증 통과, 다시 열어 이어 써도 체인 유지", () => {
    seed(3);
    const log = openAuditLog(dbPath);
    log.append({ ...decision, toolUseId: "later" });
    expect(log.verify()).toEqual({ ok: true, rows: 4 });
    log.close();
  });

  it("내용을 고치면 그 행에서 hash_mismatch", () => {
    seed(4);
    tamper(`UPDATE audit_log SET payload = replace(payload, 'approved', 'rejected') WHERE id = 3`);
    const log = openAuditLog(dbPath);
    expect(log.verify()).toMatchObject({ ok: false, brokenAtId: 3, reason: "hash_mismatch" });
    log.close();
  });

  it("중간 행을 지우면 다음 행에서 prev_mismatch", () => {
    seed(4);
    tamper("DELETE FROM audit_log WHERE id = 2");
    const log = openAuditLog(dbPath);
    expect(log.verify()).toMatchObject({ ok: false, brokenAtId: 3, reason: "prev_mismatch" });
    log.close();
  });

  it("행 내용과 해시를 함께 바꿔도 다음 행에서 걸린다", () => {
    seed(4);
    tamper(`UPDATE audit_log SET hash = 'f' || substr(hash, 2) WHERE id = 2`);
    const log = openAuditLog(dbPath);
    const result = log.verify();
    expect(result.ok).toBe(false);
    log.close();
  });
});

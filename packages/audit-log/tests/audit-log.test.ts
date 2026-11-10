import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuditEntry,
  canonicalJson,
  chainHash,
  type DecisionEntry,
  openAuditLog,
} from "../src/index.ts";

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
  reasons: ["미분류"],
  flags: [],
  outcome: "approved",
  decidedBy: "user:terminal",
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

/** 공격자가 한 행의 내용을 바꾸고, 그 행만 보면 맞도록 해시를 다시 계산해 넣는 경우 */
function rewriteRowWithValidHash(id: number): void {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT payload, prev_hash FROM audit_log WHERE id = ?").get(id);
  const payload = String(row?.payload).replace("approved", "rejected");
  const hash = chainHash(String(row?.prev_hash), payload);
  db.prepare("UPDATE audit_log SET payload = ?, hash = ? WHERE id = ?").run(payload, hash, id);
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

  it("행 내용을 고치고 그 행의 해시까지 다시 계산해도 다음 행에서 걸린다", () => {
    seed(4);
    rewriteRowWithValidHash(2);
    const log = openAuditLog(dbPath);
    expect(log.verify()).toMatchObject({ ok: false, brokenAtId: 3, reason: "prev_mismatch" });
    log.close();
  });
});

describe("읽기 전용 열기 (재생용)", () => {
  it("기록을 순서대로 돌려주고, 감사 로그를 바꾸지 않는다", async () => {
    seed(3);
    const { openAuditLogReadOnly } = await import("../src/index.ts");
    const reader = openAuditLogReadOnly(dbPath);
    const entries = [...reader.entries()];
    expect(entries.map((e) => e.entry.kind)).toEqual(["request", "decision", "decision"]);
    expect(entries[0]?.entry).toEqual(request);
    expect(reader.verify()).toEqual({ ok: true, rows: 3 });
    reader.close();
  });

  it("읽기 전용으로 연 DB에는 쓸 수 없다", async () => {
    seed(1);
    const { openAuditLogReadOnly } = await import("../src/index.ts");
    const reader = openAuditLogReadOnly(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(() => db.exec("DELETE FROM audit_log")).toThrow();
    db.close();
    reader.close();
  });
});

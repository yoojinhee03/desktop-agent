// SQLite 드라이버를 쓰는 유일한 파일. 드라이버를 바꾸면 이 파일만 바꾼다.
// 드라이버: node:sqlite (Node 내장, 네이티브 빌드 없음) — 2026-11-10 확정.
// M3 Electron 전환 시 Electron 내장 Node에서 node:sqlite 사용 가능한지 확인할 것.
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, chainHash, GENESIS_HASH, verifyChain } from "./chain.ts";
import type { AuditEntry, StoredRow, VerifyResult } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  payload    TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
)`;

export interface AuditLog {
  append(entry: AuditEntry): StoredRow;
  verify(): VerifyResult;
  close(): void;
}

interface RawRow {
  id: number;
  created_at: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

function toStored(raw: RawRow): StoredRow {
  return {
    id: raw.id,
    createdAt: raw.created_at,
    payload: raw.payload,
    prevHash: raw.prev_hash,
    hash: raw.hash,
  };
}

function* iterateRows(db: DatabaseSync): Generator<StoredRow> {
  const stmt = db.prepare("SELECT * FROM audit_log ORDER BY id");
  for (const raw of stmt.iterate()) yield toStored(raw as unknown as RawRow);
}

function appendRow(db: DatabaseSync, entry: AuditEntry, now: () => Date): StoredRow {
  db.exec("BEGIN IMMEDIATE"); // 마지막 해시 읽기와 삽입 사이에 다른 쓰기가 끼지 않게
  try {
    const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
    const prevHash = typeof last?.hash === "string" ? last.hash : GENESIS_HASH;
    const createdAt = now().toISOString();
    const payload = canonicalJson({ ...entry, createdAt });
    const hash = chainHash(prevHash, payload);
    const info = db
      .prepare("INSERT INTO audit_log (created_at, payload, prev_hash, hash) VALUES (?, ?, ?, ?)")
      .run(createdAt, payload, prevHash, hash);
    db.exec("COMMIT");
    return { id: Number(info.lastInsertRowid), createdAt, payload, prevHash, hash };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 저장된 기록 한 건 (재생·분석용) */
export interface RecordedEntry {
  id: number;
  createdAt: string;
  entry: AuditEntry;
}

export interface AuditReader {
  verify(): VerifyResult;
  entries(): Generator<RecordedEntry>;
  close(): void;
}

const KINDS = new Set(["request", "decision", "filter"]);

function parseEntry(row: StoredRow): RecordedEntry {
  const { createdAt: _c, ...rest } = JSON.parse(row.payload) as AuditEntry & { createdAt: string };
  if (!KINDS.has(rest.kind)) throw new Error(`알 수 없는 기록 종류 (${row.id}번 행): ${rest.kind}`);
  return { id: row.id, createdAt: row.createdAt, entry: rest };
}

/** 읽기 전용으로 연다 (재생·분석이 감사 로그를 바꾸지 않게) */
export function openAuditLogReadOnly(path: string): AuditReader {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    verify: () => verifyChain(iterateRows(db)),
    *entries() {
      for (const row of iterateRows(db)) yield parseEntry(row);
    },
    close: () => db.close(),
  };
}

export function openAuditLog(path: string, now: () => Date = () => new Date()): AuditLog {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return {
    append: (entry) => appendRow(db, entry, now),
    verify: () => verifyChain(iterateRows(db)),
    close: () => db.close(),
  };
}

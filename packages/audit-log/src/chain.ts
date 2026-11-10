import { createHash } from "node:crypto";
import type { StoredRow, VerifyResult } from "./types.ts";

export const GENESIS_HASH = "0".repeat(64);

/** 키 순서를 고정한 JSON. 같은 내용이면 항상 같은 문자열이 나와야 해시가 재현된다. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function chainHash(prevHash: string, payload: string): string {
  return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

/** id 순서대로 받은 행의 체인을 검증하고, 처음 깨진 행을 알려준다. */
export function verifyChain(rows: Iterable<StoredRow>): VerifyResult {
  let prev = GENESIS_HASH;
  let count = 0;
  for (const row of rows) {
    count += 1;
    if (row.prevHash !== prev) {
      return { ok: false, rows: count, brokenAtId: row.id, reason: "prev_mismatch" };
    }
    if (chainHash(row.prevHash, row.payload) !== row.hash) {
      return { ok: false, rows: count, brokenAtId: row.id, reason: "hash_mismatch" };
    }
    prev = row.hash;
  }
  return { ok: true, rows: count };
}

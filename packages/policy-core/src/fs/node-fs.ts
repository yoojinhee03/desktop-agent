// 실제 디스크를 보는 FsProbe 구현. 판정 코어에서 Node 전용 API는 이 파일과 context.ts에만 둔다.
// 모든 조회는 읽기 전용이고, 실패하면 "없음"으로 답한다(판정은 더 보수적인 쪽으로 간다).
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileStat, FsProbe } from "../types.ts";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 200_000;

export const nodeFs: FsProbe = {
  realpath,
  glob(pattern) {
    try {
      return fs.globSync(pattern).map((p) => path.resolve(String(p)));
    } catch {
      return []; // 잘못된 패턴: 셸도 펼치지 못하므로 원문 그대로 판정한다
    }
  },
  stat(p) {
    try {
      return toStat(fs.statSync(p));
    } catch {
      return null; // 없는 경로
    }
  },
  measure(p) {
    const acc = { files: 0, bytes: 0, seen: 0 };
    walk(p, acc);
    return { files: acc.files, bytes: acc.bytes };
  },
  readText(p) {
    try {
      if (fs.statSync(p).size > MAX_TEXT_BYTES) return null;
      const buf = fs.readFileSync(p);
      return buf.includes(0) ? null : buf.toString("utf8");
    } catch {
      return null; // 읽을 수 없으면 내용 미상 → 호출 쪽에서 2등급 이상으로 처리
    }
  },
};

function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    // 아직 없는 경로: 존재하는 부모까지 해석하고 나머지를 붙인다
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realpath(parent), path.basename(p));
  }
}

function toStat(s: fs.Stats): FileStat {
  return {
    type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
    size: s.size,
    executable: (s.mode & 0o111) !== 0,
  };
}

function walk(p: string, acc: { files: number; bytes: number; seen: number }): void {
  if (acc.seen++ > MAX_WALK_ENTRIES) return;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // 없는 경로는 0개
  }
  if (!st.isDirectory()) {
    acc.files += 1;
    acc.bytes += st.size;
    return;
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(p);
  } catch {
    acc.files += 1; // 읽을 수 없는 폴더는 1개로 센다
    return;
  }
  for (const e of entries) walk(path.join(p, e), acc);
}

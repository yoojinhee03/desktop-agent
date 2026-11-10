// 테스트용 가짜 파일 시스템. 디스크를 건드리지 않고 판정에 필요한 조회만 흉내 낸다.
import type { FileStat, FsProbe } from "../../src/types.ts";

export interface FakeEntry {
  size?: number | undefined;
  content?: string | undefined;
  executable?: boolean | undefined;
  /** 심볼릭 링크 대상(절대 경로) */
  link?: string | undefined;
  dir?: boolean | undefined;
}

export function fakeFs(entries: Record<string, FakeEntry>): FsProbe {
  const files = new Map(Object.entries(entries));
  const isDir = (p: string) =>
    files.get(p)?.dir === true || [...files.keys()].some((k) => k.startsWith(`${p}/`));
  const resolve = (p: string): string => realpath(p, files);
  return {
    realpath: resolve,
    glob: (pattern) => globFake(pattern, files),
    stat(p) {
      const real = resolve(p);
      const e = files.get(real);
      if (e && !e.dir) return fileStat(e);
      return isDir(real) ? { type: "dir", size: 0, executable: true } : null;
    },
    measure(p) {
      const real = resolve(p);
      let n = 0;
      let bytes = 0;
      for (const [k, e] of files) {
        if ((k === real || k.startsWith(`${real}/`)) && !e.dir && !e.link) {
          n += 1;
          bytes += e.size ?? 0;
        }
      }
      return { files: n, bytes };
    },
    readText: (p) => files.get(resolve(p))?.content ?? null,
  };
}

function fileStat(e: FakeEntry): FileStat {
  return { type: "file", size: e.size ?? 0, executable: e.executable ?? false };
}

function realpath(p: string, files: Map<string, FakeEntry>): string {
  const segs = p.split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < segs.length; i++) {
    cur = `${cur}/${segs[i]}`;
    const link = files.get(cur)?.link;
    if (link)
      return realpath(link + (i + 1 < segs.length ? `/${segs.slice(i + 1).join("/")}` : ""), files);
  }
  return cur || "/";
}

/** bash처럼 * 는 / 와 맨 앞 . 을 넘지 않는다 */
function globFake(pattern: string, files: Map<string, FakeEntry>): string[] {
  const re = new RegExp(
    `^${pattern
      .split("/")
      .map((seg) =>
        seg
          .replace(/[.+^${}()|\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/^\[\^\/\]\*/, "(?!\\.)[^/]*"),
      )
      .join("/")}$`,
  );
  const candidates = new Set<string>();
  for (const k of files.keys()) {
    const segs = k.split("/");
    for (let i = 2; i <= segs.length; i++) candidates.add(segs.slice(0, i).join("/"));
  }
  return [...candidates].filter((c) => re.test(c)).sort();
}

// 경로 정규화와 경로 규칙 적용.
// ~, $HOME, 상대 경로, .. 를 절대 경로로 바꾸고, 심볼릭 링크는 실제 경로로도 판정한다(둘 중 높은 등급).
import type { Word } from "./parse/model.ts";
import { hasGlob } from "./parse/words.ts";
import { isAncestorOf, matchesAny } from "./rules/glob.ts";
import type { CompiledClass, RuleSet } from "./rules/load.ts";
import type { DecideContext, Grade } from "./types.ts";

export type PathOp = "read" | "write" | "delete" | "meta" | "upload";

export interface PathBase {
  home: string;
  /** null이면 작업 폴더를 알 수 없음(동적 cd 이후) → 상대 경로는 판정 불가 */
  cwd: string | null;
}

/** 순수 문자열 정규화 (디스크를 보지 않음). 알 수 없으면 null */
export function normalizePath(raw: string, base: PathBase): string | null {
  let p = raw;
  if (p === "~" || p.startsWith("~/")) p = base.home + p.slice(1);
  else if (/^~[^/]/.test(p)) return null; // ~user 형태는 판정 불가
  if (!p.startsWith("/")) {
    if (base.cwd === null) return null;
    p = `${base.cwd}/${p}`;
  }
  return collapse(p);
}

function collapse(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** 단어 → 실제 대상 경로 목록. 글로브·중괄호를 펼친다. 알 수 없으면 null */
export function wordPaths(word: Word, base: PathBase, ctx: DecideContext): string[] | null {
  if (word.value === null) return null;
  const out: string[] = [];
  for (const v of expandBraces(word.value)) {
    const abs = normalizePath(v, base);
    if (abs === null) return null;
    if (word.glob && hasGlob(abs)) {
      const hits = ctx.fs.glob(abs);
      out.push(...(hits.length > 0 ? hits : [abs]));
    } else out.push(abs);
  }
  return out;
}

/** a{b,c}d → abd, acd (중첩 없는 단순 형태만) */
export function expandBraces(v: string): string[] {
  const m = v.match(/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s);
  if (!m) return [v];
  const [, pre = "", body = "", post = ""] = m;
  return body.split(",").flatMap((b) => expandBraces(`${pre}${b}${post}`));
}

export interface PathHit {
  cls: CompiledClass;
  grade: Grade;
  /** 상위 디렉터리라서 걸린 것인지 (예: rm -rf ~/.ssh → 개인키) */
  viaAncestor: boolean;
}

/** 경로 하나에 맞는 경로 규칙들. recursive면 보호 경로의 상위 디렉터리도 검사한다 */
export function classifyPath(
  abs: string,
  op: PathOp,
  recursive: boolean,
  rules: RuleSet,
  ctx: DecideContext,
): PathHit[] {
  const candidates = unique([abs, ctx.fs.realpath(abs)]);
  const hits: PathHit[] = [];
  for (const cls of rules.classes) {
    const hit = matchClass(cls, candidates, op, recursive);
    if (hit) hits.push(hit);
  }
  if (candidates.some((c) => ctx.session.taintedFiles.includes(c))) {
    const cred = rules.classes.find((c) => c.id === "path.credentials");
    if (cred) hits.push({ cls: cred, grade: gradeFor(cred, op), viaAncestor: false });
  }
  return hits;
}

function matchClass(
  cls: CompiledClass,
  candidates: string[],
  op: PathOp,
  recursive: boolean,
): PathHit | null {
  const direct = candidates.some(
    (c) => matchesAny(c, cls.compiled) && !matchesAny(c, cls.compiledExcept),
  );
  if (direct) return { cls, grade: gradeFor(cls, op), viaAncestor: false };
  if (!recursive || !cls.guard_ancestors || op === "meta") return null;
  const ancestor = candidates.some((c) => cls.compiled.some((g) => isAncestorOf(c, g)));
  return ancestor ? { cls, grade: gradeFor(cls, op), viaAncestor: true } : null;
}

function gradeFor(cls: CompiledClass, op: PathOp): Grade {
  if (op === "meta") return 0;
  if (op === "read") return cls.read;
  if (op === "upload") return cls.upload ?? cls.read;
  return cls.write;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function isInsideHome(abs: string, home: string): boolean {
  return abs === home || abs.startsWith(`${home}/`);
}

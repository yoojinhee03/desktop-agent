// 단어(인자·리다이렉션 대상)에 경로 규칙을 적용해 근거를 쌓는다.
import type { Word } from "../parse/model.ts";
import { classifyPath, isInsideHome, type PathOp, wordPaths } from "../paths.ts";
import type { Grade } from "../types.ts";
import { addEngine, addFinding, type CmdInfo, type JudgeCtx } from "./state.ts";

const OP_LABEL: Record<PathOp, string> = {
  read: "읽기",
  write: "쓰기",
  delete: "삭제",
  meta: "조회",
  upload: "업로드",
};

export interface PathOptions {
  /** 대상이 홈 밖이면 적용할 최소 등급과 그 근거 규칙 */
  outsideHome?: { grade: Grade; ruleId: string; reason: string };
}

/** 단어의 경로들을 판정하고 절대 경로 목록을 돌려준다. 경로를 알 수 없으면 2등급 근거를 남긴다 */
export function judgeWordPaths(
  jc: JudgeCtx,
  word: Word,
  op: PathOp,
  recursive: boolean,
  info: CmdInfo,
  opts: PathOptions = {},
): string[] {
  if (op === "meta" && word.value === null) return [];
  const paths = wordPaths(word, jc.base, jc.ctx);
  if (paths === null) {
    addEngine(jc, "path.dynamic", word.raw);
    return [];
  }
  for (const p of paths) judgePath(jc, p, op, recursive || word.implicit === true, info, opts);
  return paths;
}

export function judgePath(
  jc: JudgeCtx,
  abs: string,
  op: PathOp,
  recursive: boolean,
  info: CmdInfo,
  opts: PathOptions = {},
): void {
  for (const hit of classifyPath(abs, op, recursive, jc.rules, jc.ctx)) {
    const cls = hit.cls;
    if ((op === "read" || op === "upload") && cls.credential && !isRoutine(cls.id))
      info.credRead = true;
    if (op === "read" && cls.local_only) jc.acc.flags.add("local_only");
    if (hit.grade === 0) continue;
    const where = `${display(abs, jc.ctx.home)}${hit.viaAncestor ? " (하위 경로 포함)" : ""}`;
    addFinding(jc, {
      grade: hit.grade,
      ruleId: cls.id,
      reason: `${cls.reason} ${OP_LABEL[op]}: ${where}`,
      allowKey: hit.grade === 2 ? `${cls.id}.${op}:${abs}` : null,
    });
  }
  applyOutsideHome(jc, abs, opts);
  record(jc, abs, op, info);
}

function isRoutine(id: string): boolean {
  return id === "path.home" || id === "path.temp";
}

function applyOutsideHome(jc: JudgeCtx, abs: string, opts: PathOptions): void {
  const o = opts.outsideHome;
  if (!o || isInsideHome(abs, jc.ctx.home)) return;
  addFinding(jc, {
    grade: o.grade,
    ruleId: o.ruleId,
    reason: `${o.reason} (홈 밖): ${abs}`,
    allowKey: null,
  });
}

function record(jc: JudgeCtx, abs: string, op: PathOp, info: CmdInfo): void {
  if (op === "read" || op === "upload") info.readPaths.push(abs);
  if (op === "write" || op === "delete") jc.acc.previewPaths.add(abs);
  if (op === "write") {
    info.writes.push(abs);
    jc.acc.writes.add(abs);
  }
}

export function display(abs: string, home: string): string {
  return isInsideHome(abs, home) ? `~${abs.slice(home.length)}` : abs;
}

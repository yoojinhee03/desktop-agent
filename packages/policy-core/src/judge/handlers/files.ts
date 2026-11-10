// 파일 삭제·쓰기 계열: rm(휴지통 치환·대량 삭제 승격), find(-delete, -exec), dd, open
import type { Word } from "../../parse/model.ts";
import { classifyPath, normalizePath, wordPaths } from "../../paths.ts";
import { judgeArgv } from "../command.ts";
import { isRecursive, operands } from "../match.ts";
import { display, judgePath, judgeWordPaths } from "../path-judge.ts";
import { addEngine, addFinding, type CmdInfo, type JudgeCtx, noRewrite } from "../state.ts";
import { type HandlerFn, innerCmd, syntheticWord } from "./types.ts";

// ---------- rm ----------

export const rmHandler: HandlerFn = (jc, { head, name, args, info }) => {
  const recursive =
    name === "rm" &&
    isRecursive(
      "rm",
      args.map((a) => a.value),
    );
  const targets = operands(args);
  if (targets.length === 0) return;
  const paths: string[] = [];
  for (const t of targets) {
    if (wipesHomeOrRoot(t, jc)) addEngine(jc, "block.delete_home_or_root", t.raw);
    paths.push(...judgeWordPaths(jc, t, "delete", recursive, info));
  }
  checkBulk(jc, paths, recursive);
  if (jc.permanentDelete || !jc.rewritable || targets.some((t) => t.implicit)) {
    addEngine(jc, "cmd.rm.permanent", targets.map((t) => t.raw).join(" "));
    return;
  }
  const last = args.at(-1) ?? head;
  jc.acc.rewrites.push({ start: head.start, end: last.end, text: trashCommand(jc, targets) });
};

/** ~/*, /*, ~/.* 처럼 홈·루트 바로 아래를 통째로 지우는 글로브 */
function wipesHomeOrRoot(w: Word, jc: JudgeCtx): boolean {
  if (w.value === null || !w.glob) return false;
  const abs = normalizePath(w.value, jc.base);
  if (abs === null) return false;
  const cut = abs.lastIndexOf("/");
  const dir = cut <= 0 ? "/" : abs.slice(0, cut);
  const leaf = abs.slice(cut + 1);
  return (dir === "/" || dir === jc.ctx.home) && /^\.?\*$/.test(leaf);
}

function checkBulk(jc: JudgeCtx, paths: string[], recursive: boolean): void {
  let files = 0;
  let bytes = 0;
  for (const p of paths) {
    const st = jc.ctx.fs.stat(p);
    if (!st) continue;
    if (st.type !== "dir") {
      files += 1;
      bytes += st.size;
    } else if (recursive) {
      const m = jc.ctx.fs.measure(p);
      files += m.files;
      bytes += m.bytes;
    }
  }
  const count = jc.acc.count;
  count.measured = true;
  count.files += files;
  count.bytes += bytes;
  const limit = jc.rules.file.defaults.bulk_delete;
  if (files > limit.file_count_gt || bytes > limit.total_bytes_gt) {
    addEngine(jc, "cmd.rm.bulk", `${files}개, ${formatBytes(bytes)}`);
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${Math.ceil(n / 1024)}KB`;
}

/** 휴지통 명령. 같은 위치를 공유하는 단어(변수 분리)는 값을 따옴표로, 나머지는 원문 그대로(글로브 유지) */
function trashCommand(jc: JudgeCtx, targets: Word[]): string {
  const parts = targets.map((t) => {
    const shared = targets.some((o) => o !== t && o.start === t.start);
    const text = shared || t.value === null ? (shared ? quote(t.value ?? "") : t.raw) : t.raw;
    return text.startsWith("-") ? `./${text}` : text;
  });
  return `${jc.rules.file.defaults.trash_command} ${parts.join(" ")}`;
}

function quote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

// ---------- find ----------

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_WRITE = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);
/** 보호 경로 자체가 아니라 그 상위 디렉터리에서 find로 지우는 경우는 "범위 확정 불가"로 2등급 */
const BROAD_CLASSES = new Set(["path.root_or_home", "path.home", "path.temp", "path.outside_home"]);

export const findHandler: HandlerFn = (jc, { cmd, args, info }) => {
  const start = args.findIndex(
    (a) => a.value !== null && /^[-(!)]/.test(a.value) && a.value !== "-",
  );
  const rootWords = start < 0 ? args : args.slice(0, start);
  const roots = rootWords.length > 0 ? rootWords : [syntheticWord(".", args[0])];
  args.forEach((a, i) => {
    const next = args[i + 1];
    if (a.value && FIND_WRITE.has(a.value) && next) judgeWordPaths(jc, next, "write", false, info);
  });
  const del = args.find((a) => a.value === "-delete");
  if (del) findDelete(jc, roots, del, info, !hasFilter(args.slice(rootWords.length)));
  for (const inner of execClauses(args, roots)) {
    judgeArgv(innerCmd(cmd, inner), inner, noRewrite(jc), info);
  }
};

/** 대상을 좁히는 조건 없이 -delete 만 있으면 시작 위치 아래 전체 삭제와 같다 */
const NOT_FILTER = new Set([
  "-delete",
  "-depth",
  "-d",
  "-x",
  "-xdev",
  "-mount",
  "-print",
  "-print0",
  "-follow",
]);
const NOT_FILTER_WITH_VALUE = new Set(["-maxdepth", "-mindepth"]);

function hasFilter(expr: Word[]): boolean {
  for (let i = 0; i < expr.length; i++) {
    const v = expr[i]?.value;
    if (v === null || v === undefined) return true;
    if (NOT_FILTER_WITH_VALUE.has(v)) i++;
    else if (!NOT_FILTER.has(v)) return true;
  }
  return false;
}

function findDelete(
  jc: JudgeCtx,
  roots: Word[],
  del: Word,
  info: CmdInfo,
  wholeTree: boolean,
): void {
  for (const r of roots) {
    const paths = wordPaths(r, jc.base, jc.ctx);
    if (paths === null) {
      addEngine(jc, "path.dynamic", r.raw);
      continue;
    }
    for (const p of paths) {
      if (wholeTree) judgePath(jc, p, "delete", true, info);
      else findDeleteRoot(jc, p);
    }
    info.writes.push(...paths);
  }
  if (jc.permanentDelete || !jc.rewritable) {
    addEngine(jc, "cmd.rm.permanent", "find -delete");
    return;
  }
  const trash = jc.rules.file.defaults.trash_command;
  jc.acc.rewrites.push({ start: del.start, end: del.end, text: `-depth -exec ${trash} {} +` });
}

function findDeleteRoot(jc: JudgeCtx, p: string): void {
  jc.acc.previewPaths.add(p);
  for (const hit of classifyPath(p, "delete", true, jc.rules, jc.ctx)) {
    if (hit.grade === 0) continue;
    if (BROAD_CLASSES.has(hit.cls.id) && hit.cls.id !== "path.outside_home") continue;
    if (hit.viaAncestor) {
      addEngine(jc, "cmd.find.unbounded", `${display(p, jc.ctx.home)} 아래 ${hit.cls.reason}`);
      continue;
    }
    addFinding(jc, {
      grade: hit.grade,
      ruleId: hit.cls.id,
      reason: `${hit.cls.reason} 삭제: ${display(p, jc.ctx.home)}`,
      allowKey: null,
    });
  }
}

/** -exec … ; 절마다 안쪽 명령. {} 자리는 시작 위치 아래 전체로 본다 */
function execClauses(args: Word[], roots: Word[]): Word[][] {
  const out: Word[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXEC.has(args[i]?.value ?? "")) continue;
    const inner: Word[] = [];
    for (i++; i < args.length && args[i]?.value !== ";" && args[i]?.value !== "+"; i++) {
      const w = args[i];
      if (!w) continue;
      if (w.value?.includes("{}")) inner.push(...roots.map((r) => ({ ...r, implicit: true })));
      else inner.push(w);
    }
    if (inner.length > 0) out.push(inner);
  }
  return out;
}

// ---------- dd ----------

export const ddHandler: HandlerFn = (jc, { args, info }) => {
  for (const a of args) {
    const m = a.value?.match(/^(if|of)=(.+)$/);
    if (!m?.[2]) continue;
    judgeWordPaths(jc, syntheticWord(m[2], a), m[1] === "if" ? "read" : "write", false, info);
  }
};

// ---------- open ----------

const OPEN_WITH_VALUE = new Set([
  "-a",
  "-b",
  "-s",
  "-u",
  "--env",
  "--stdin",
  "--stdout",
  "--stderr",
]);
const RUNNABLE_EXT =
  /\.(app|command|pkg|mpkg|tool|terminal|sh|workflow|scpt|scptd|action|dmg)\/?$/i;

export const openHandler: HandlerFn = (jc, { args, info }) => {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === "--args") break;
    if (v && OPEN_WITH_VALUE.has(v)) {
      i++;
      continue;
    }
    if (v?.startsWith("-")) continue;
    const w = args[i];
    if (w) openTarget(jc, w, info);
  }
};

function openTarget(jc: JudgeCtx, w: Word, info: CmdInfo): void {
  if (w.value !== null && /^[a-z][a-z0-9+.-]*:/i.test(w.value)) {
    info.network = true;
    return;
  }
  const paths = wordPaths(w, jc.base, jc.ctx);
  if (paths === null) {
    addEngine(jc, "path.dynamic", w.raw);
    return;
  }
  for (const p of paths) {
    const st = jc.ctx.fs.stat(p);
    if (RUNNABLE_EXT.test(p) || (st?.type === "file" && st.executable)) {
      addEngine(jc, "cmd.exec.script", `실행 파일 열기: ${display(p, jc.ctx.home)}`);
    }
  }
}

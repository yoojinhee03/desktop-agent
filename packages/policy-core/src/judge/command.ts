// 단위 명령 하나의 판정: 리다이렉션 → 명령 규칙 → 경로 규칙 → 네트워크 규칙. 근거는 jc.acc에 쌓는다.
import type { Cmd, Word } from "../parse/model.ts";
import { evalStdout } from "../parse/static-eval.ts";
import type { PathOp } from "../paths.ts";
import type { CommandRule, PathSpec } from "../rules/schema.ts";
import { judgeExecFile } from "./handlers/exec.ts";
import { HANDLER_FNS } from "./handlers/index.ts";
import { isRecursive, matchedRules, nameOf, operands } from "./match.ts";
import { judgeWordPaths } from "./path-judge.ts";
import { addEngine, addFinding, type CmdInfo, emptyInfo, type JudgeCtx } from "./state.ts";

const WRITE_OPS = new Set([">", ">>", "&>", "&>>", ">|", "<>", ">&"]);
const READ_OPS = new Set(["<", "<&"]);

export function judgeCmd(cmd: Cmd, jc: JudgeCtx): CmdInfo {
  const info = emptyInfo();
  jc.infos.set(cmd, info);
  judgeRedirects(cmd, jc, info);
  judgePrefixAssigns(cmd, jc);
  if (cmd.kind !== "group" && cmd.argv.length > 0) judgeArgv(cmd, cmd.argv, jc, info);
  if (info.writes.length > 0 && (info.credRead || upstreamCred(cmd, jc))) {
    for (const w of info.writes) jc.acc.tainted.add(w);
  }
  return info;
}

/** argv(이름 + 인자)를 판정한다. 감싸는 명령(sudo, env, xargs…)의 안쪽 명령도 이 함수로 판정한다 */
export function judgeArgv(cmd: Cmd, argv: Word[], jc: JudgeCtx, info: CmdInfo): void {
  const head = nameOf(argv[0]);
  const args = argv.slice(1);
  if (head.kind === "dynamic") {
    addEngine(jc, "cmd.dynamic_name", argv[0]?.raw);
    // 무슨 명령인지 몰라도 인자의 경로는 판정한다 ($CMD ~/.ssh/id_rsa)
    for (const w of operands(args)) judgeWordPaths(jc, w, "read", w.implicit === true, info);
    return;
  }
  if (head.kind === "path") {
    judgeExecFile(jc, argv[0], info);
    for (const w of operands(args)) judgeWordPaths(jc, w, "read", false, info);
    return;
  }
  const values = args.map((w) => w.value);
  const cmdRules = matchedRules(jc.rules.commands, head.name, values);
  const netRules = matchedRules(jc.rules.network, head.name, values);
  if (cmdRules.length + netRules.length === 0) {
    unclassified(head.name, args, jc, info);
    return;
  }
  applyRules(cmd, argv[0] as Word, head.name, args, [...cmdRules, ...netRules], jc, info);
}

function applyRules(
  cmd: Cmd,
  headWord: Word,
  name: string,
  args: Word[],
  rules: CommandRule[],
  jc: JudgeCtx,
  info: CmdInfo,
): void {
  const handlers = new Set<string>();
  for (const r of rules) {
    addFinding(jc, {
      grade: r.grade,
      ruleId: r.id,
      reason: r.reason,
      allowKey: r.session_allow ? r.id : null,
    });
    info.network ||= r.network;
    for (const spec of specList(r.paths)) applyPathSpec(spec, r, name, args, jc, info);
  }
  for (const r of rules) {
    if (!r.handler || handlers.has(r.handler)) continue;
    handlers.add(r.handler);
    HANDLER_FNS[r.handler](jc, { cmd, head: headWord, name, args, info, rule: r });
  }
}

function specList(p: PathSpec | PathSpec[] | undefined): PathSpec[] {
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

function applyPathSpec(
  spec: PathSpec,
  rule: CommandRule,
  name: string,
  args: Word[],
  jc: JudgeCtx,
  info: CmdInfo,
): void {
  const ops = selectArgs(operands(args), spec.args);
  const recursive =
    spec.recursive === "always" ||
    (spec.recursive === "flag" &&
      isRecursive(
        name,
        args.map((a) => a.value),
      ));
  const outsideHome =
    spec.outside_home === undefined
      ? undefined
      : { grade: spec.outside_home, ruleId: rule.id, reason: rule.reason };
  for (const w of ops)
    judgeWordPaths(jc, w, spec.op, recursive, info, outsideHome ? { outsideHome } : {});
}

export function selectArgs(ops: Word[], which: PathSpec["args"]): Word[] {
  switch (which) {
    case "first":
      return ops.slice(0, 1);
    case "last":
      return ops.slice(-1);
    case "all_but_last":
      return ops.slice(0, -1);
    case "after_first":
      return ops.slice(1);
    default:
      return ops;
  }
}

function unclassified(name: string, args: Word[], jc: JudgeCtx, info: CmdInfo): void {
  addEngine(jc, "cmd.unclassified", name, name);
  // 무엇을 하는지 모르는 명령: 인자로 넘긴 경로는 읽기로 판정해 개인키 등은 그대로 막는다
  for (const w of operands(args)) judgeWordPaths(jc, w, "read", w.implicit === true, info);
}

// ---------- 리다이렉션 ----------

function judgeRedirects(cmd: Cmd, jc: JudgeCtx, info: CmdInfo): void {
  for (const r of cmd.redirects) {
    if (!r.target) continue;
    const op: PathOp | null = WRITE_OPS.has(r.op) ? "write" : READ_OPS.has(r.op) ? "read" : null;
    if (!op) continue;
    const paths = judgeWordPaths(jc, r.target, op, false, info);
    if (op === "write") rememberContent(cmd, r.op === ">>", paths, jc);
  }
}

/** 같은 호출 안에서 쓴 파일을 나중에 실행하면 그 내용을 판정할 수 있게 기억한다 */
function rememberContent(cmd: Cmd, append: boolean, paths: string[], jc: JudgeCtx): void {
  const out = cmd.kind === "group" ? null : evalStdout(cmd);
  for (const p of paths) {
    if (!append || out === null) {
      jc.pending.set(p, out);
      continue;
    }
    const prev = jc.pending.has(p) ? jc.pending.get(p) : jc.ctx.fs.readText(p);
    jc.pending.set(p, prev === null || prev === undefined ? null : prev + out);
  }
}

// ---------- 앞에 붙은 변수 대입 (PATH=… cmd) ----------

function judgePrefixAssigns(cmd: Cmd, jc: JudgeCtx): void {
  if (cmd.kind !== "simple") return;
  for (const a of cmd.assigns) {
    const arg = `${a.name}=${a.value ?? ""}`;
    for (const r of matchedRules(jc.rules.commands, "(assign)", [arg])) {
      if (r.grade !== 0)
        addFinding(jc, {
          grade: r.grade,
          ruleId: r.id,
          reason: `${r.reason}: ${arg}`,
          allowKey: null,
        });
    }
  }
}

function upstreamCred(cmd: Cmd, jc: JudgeCtx): boolean {
  const seen = new Set<Cmd>();
  const stack = [...cmd.pipeFrom];
  while (stack.length > 0) {
    const c = stack.pop();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (jc.infos.get(c)?.credRead) return true;
    stack.push(...c.pipeFrom);
  }
  return false;
}

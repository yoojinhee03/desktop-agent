// 다른 코드를 실행하는 명령: 셸, source, eval, 파일 실행, cd (감싸는 명령·xargs는 wrap.ts)
import type { Cmd, Word } from "../../parse/model.ts";
import { staticArgs } from "../../parse/model.ts";
import { evalStdout } from "../../parse/static-eval.ts";
import { normalizePath } from "../../paths.ts";
import { operands } from "../match.ts";
import { judgeScript } from "../script.ts";
import { addEngine, type CmdInfo, type JudgeCtx, mergeInfo, nested, shortCode } from "../state.ts";
import { scanCode } from "./code.ts";
import type { HandlerFn } from "./types.ts";
import { optionValue } from "./wrap.ts";

// ---------- 셸 (bash -c, bash script.sh, … | sh) ----------

export const shellHandler: HandlerFn = (jc, { cmd, args, info }) => {
  const code = optionValue(args, "-c");
  if (code) {
    const rest = args.slice(args.indexOf(code) + 1);
    judgeShellString(code, jc, info, staticArgs(rest) ?? []);
    return;
  }
  const file = scriptOperand(args);
  if (file) {
    judgeScriptWord(file, jc, info);
    return;
  }
  judgeStdinScript(cmd, jc, (text) => mergeInfo(info, judgeScript(text, nested(jc))));
};

/** bash 옵션 뒤 첫 인자 (스크립트 파일). -o/-O 는 값을 받는다 */
function scriptOperand(args: Word[]): Word | null {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === "-o" || v === "-O" || v === "--rcfile" || v === "--init-file") {
      i++;
      continue;
    }
    if (v === "-s") return null;
    if (v?.startsWith("-")) continue;
    return args[i] ?? null;
  }
  return null;
}

/** 셸에 넘기는 코드 문자열: 정적이면 다시 파싱(깊이 +1), 아니면 2등급(원격 내용이면 3등급) */
export function judgeShellString(
  code: Word,
  jc: JudgeCtx,
  info: CmdInfo,
  positional: string[] = [],
): void {
  if (code.value !== null) {
    mergeInfo(info, judgeScript(code.value, { ...nested(jc), positional }));
    return;
  }
  if (fromNetwork(code.inner, jc)) addEngine(jc, "cmd.remote_script", code.raw);
  else addEngine(jc, "cmd.shell.dynamic", shortCode(code.raw));
  jc.acc.flags.add("dynamic_code");
}

function judgeScriptWord(file: Word, jc: JudgeCtx, info: CmdInfo): void {
  if (file.procSubst) {
    if (fromNetwork(file.inner, jc)) addEngine(jc, "cmd.remote_script", file.raw);
    else addEngine(jc, "cmd.shell.dynamic", file.raw);
    return;
  }
  judgeExecFile(jc, file, info, "shell");
}

/** 표준 입력으로 받는 스크립트: 히어독·히어스트링·파이프·< 파일 */
export function judgeStdinScript(cmd: Cmd, jc: JudgeCtx, judgeText: (t: string) => void): void {
  if (cmd.pipeFrom.some((c) => fromNetworkCmd(c, jc))) {
    addEngine(jc, "cmd.remote_script", "파이프로 받은 원격 내용");
    return;
  }
  const text = stdinText(cmd, jc);
  if (text !== null) {
    judgeText(text);
    return;
  }
  const hasInput = cmd.pipeFrom.length > 0 || cmd.redirects.some((r) => r.op.startsWith("<"));
  addEngine(
    jc,
    hasInput ? "cmd.shell.dynamic" : "cmd.exec.script",
    "표준 입력 내용을 미리 알 수 없음",
  );
  jc.acc.flags.add("dynamic_code");
}

/** 표준 입력으로 들어오는 내용을 정적으로 알 수 있으면 그 문자열 (히어독, < 파일, echo … |) */
export function stdinTextOf(cmd: Cmd, jc: JudgeCtx): string | null {
  return stdinText(cmd, jc);
}

function stdinText(cmd: Cmd, jc: JudgeCtx): string | null {
  const body = cmd.redirects.find((r) => r.op === "<<" || r.op === "<<<");
  if (body) return body.body;
  const fileIn = cmd.redirects.find((r) => r.op === "<" && r.target);
  if (fileIn?.target) return fileText(fileIn.target, jc);
  if (cmd.pipeFrom.length !== 1 || !cmd.pipeFrom[0]) return null;
  const src = cmd.pipeFrom[0];
  const out = evalStdout(src);
  if (out !== null) return out;
  const srcArgs = staticArgs(src.argv);
  if (srcArgs?.[0] === "cat" && srcArgs.length === 2 && src.argv[1])
    return fileText(src.argv[1], jc);
  return null;
}

function fileText(w: Word, jc: JudgeCtx): string | null {
  const abs = w.value === null ? null : normalizePath(w.value, jc.base);
  if (abs === null) return null;
  return jc.pending.has(abs) ? (jc.pending.get(abs) ?? null) : jc.ctx.fs.readText(abs);
}

/** 앞 단계 중 하나라도 외부 통신 명령이면 true (curl … | gunzip | sh 도 포함) */
function fromNetworkCmd(c: Cmd, jc: JudgeCtx): boolean {
  const seen = new Set<Cmd>();
  const stack = [c];
  while (stack.length > 0) {
    const x = stack.pop();
    if (!x || seen.has(x)) continue;
    seen.add(x);
    if (jc.infos.get(x)?.network || isNetworkName(x)) return true;
    stack.push(...x.pipeFrom);
  }
  return false;
}

function fromNetwork(cmds: Cmd[], jc: JudgeCtx): boolean {
  return cmds.some((c) => fromNetworkCmd(c, jc));
}

const NETWORK_NAMES = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ftp",
  "scp",
  "ssh",
]);

function isNetworkName(c: Cmd): boolean {
  const v = c.argv[0]?.value ?? "";
  return NETWORK_NAMES.has(v.slice(v.lastIndexOf("/") + 1));
}

// ---------- source, eval ----------

export const sourceHandler: HandlerFn = (jc, { args, info }) => {
  const file = operands(args)[0];
  if (file) judgeScriptWord(file, jc, info);
};

export const evalHandler: HandlerFn = (jc, { args, info }) => {
  const values = staticArgs(args);
  const code = args.map((a) => a.raw).join(" ");
  jc.acc.flags.add("dynamic_code");
  if (values === null) {
    const inner = args.flatMap((a) => a.inner);
    addEngine(
      jc,
      fromNetwork(inner, jc) ? "cmd.remote_script" : "cmd.dynamic_code",
      shortCode(code),
    );
    return;
  }
  addEngine(jc, "cmd.dynamic_code", shortCode(values.join(" ")));
  mergeInfo(info, judgeScript(values.join(" "), nested(jc)));
};

// ---------- 파일 실행 (./x.sh, bash x.sh, source x) ----------

/**
 * 파일 실행. 최소 2등급이고, 내용을 읽을 수 있으면 내용까지 판정해 더 높은 등급을 따른다.
 * via: exec(./x, 셔뱅으로 언어 판단) · shell(bash x, source x) · interpreter(python x.py: 내용은 호출 쪽이 검사)
 */
export function judgeExecFile(
  jc: JudgeCtx,
  word: Word | undefined,
  info: CmdInfo,
  via = "exec",
): void {
  const abs = word?.value ? normalizePath(word.value, jc.base) : null;
  if (!word || abs === null) {
    addEngine(jc, "path.dynamic", word?.raw);
    return;
  }
  if (jc.remote.has(abs)) addEngine(jc, "cmd.remote_script", `내려받은 파일 실행: ${word.raw}`);
  const written = jc.pending.has(abs) || jc.ctx.session.writtenFiles.includes(abs);
  addEngine(jc, written ? "cmd.exec.agent_written" : "cmd.exec.script", word.raw);
  if (via === "interpreter") return;
  const text = jc.pending.has(abs) ? (jc.pending.get(abs) ?? null) : jc.ctx.fs.readText(abs);
  if (text === null) return;
  const lang = shebangLang(text);
  if (via === "exec" && lang !== null) {
    scanCode(text, lang, nested(jc), info);
    return;
  }
  mergeInfo(info, judgeScript(text, nested(jc)));
}

/** 셔뱅이 셸이 아닌 언어면 그 이름 (python, node …). 셸이거나 없으면 null */
function shebangLang(text: string): string | null {
  const line = text.match(/^#!([^\n]*)/)?.[1] ?? "";
  const m = line.match(/\b(python|node|perl|ruby|osascript|php|deno|bun|awk)/);
  return m?.[1] ?? null;
}

// ---------- cd ----------

export const cdHandler: HandlerFn = (jc, { name, args }) => {
  const target = operands(args)[0];
  if (name === "popd" || target?.value === "-") {
    jc.base.cwd = null;
    return;
  }
  if (!target) {
    jc.base.cwd = jc.ctx.home;
    return;
  }
  jc.base.cwd = target.value === null ? null : normalizePath(target.value, jc.base);
};

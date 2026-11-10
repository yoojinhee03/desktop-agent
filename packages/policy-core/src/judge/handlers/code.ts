// 스크립트 언어(python -c, node -e, osascript -e …)와 awk 프로그램.
// 최소 2등급(코드를 그대로 표시)이고, 코드 안에서 다음을 찾아 더 높은 등급을 적용한다.
//   - 셸로 넘기는 문자열: os.system("…"), subprocess.run([...]), do shell script "…", system("…") → 다시 판정
//   - 경로 문자열: "~/.ssh/id_rsa" 등 → 경로 규칙(읽기)
//   - 위험 표시(code_tokens): id_rsa, Login Data 등 → 규칙 파일의 등급
import type { Word } from "../../parse/model.ts";
import { normalizePath } from "../../paths.ts";
import { operands } from "../match.ts";
import { judgePath, judgeWordPaths } from "../path-judge.ts";
import { judgeScript } from "../script.ts";
import {
  addEngine,
  addFinding,
  type CmdInfo,
  type JudgeCtx,
  mergeInfo,
  nested,
  shortCode,
} from "../state.ts";
import { judgeExecFile, judgeStdinScript } from "./exec.ts";
import type { HandlerFn } from "./types.ts";

/** 언어별 "코드를 인자로 받는" 옵션 */
const CODE_FLAGS: Record<string, string[]> = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  osascript: ["-e"],
  lua: ["-e"],
  expect: ["-c"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  tsx: ["-e", "--eval"],
  "ts-node": ["-e", "--eval"],
};

function lang(name: string): string {
  if (/^python/.test(name)) return "python";
  if (name === "nodejs") return "node";
  return name;
}

export const interpreterHandler: HandlerFn = (jc, { cmd, name, args, info }) => {
  const l = lang(name);
  const codes = codeArgs(args, CODE_FLAGS[l] ?? []);
  if (codes.length > 0) {
    for (const c of codes) judgeCodeWord(c, l, jc, info);
    return;
  }
  if (args.some((a) => a.value === "-m")) {
    addEngine(jc, "cmd.dynamic_code", `${name} ${args.map((a) => a.raw).join(" ")}`);
    return;
  }
  const file = operands(args).find((w) => w.value !== "-");
  if (file) {
    judgeExecFile(jc, file, info, "interpreter");
    const abs = file.value ? normalizePath(file.value, jc.base) : null;
    const text = abs ? (jc.pending.get(abs) ?? jc.ctx.fs.readText(abs)) : null;
    if (text !== null) scanCode(text, l, nested(jc), info);
    return;
  }
  judgeStdinScript(cmd, jc, (text) => scanCode(text, l, nested(jc), info));
};

function codeArgs(args: Word[], flags: string[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value ?? "";
    const next = args[i + 1];
    if (flags.includes(v) && next) out.push(next);
    // -c'code', -e"code" 처럼 붙여 쓴 형태
    const glued = flags.find((f) => f.length === 2 && v.startsWith(f) && v.length > 2);
    if (glued && args[i]) out.push({ ...(args[i] as Word), value: v.slice(2) });
  }
  return out;
}

function judgeCodeWord(code: Word, l: string, jc: JudgeCtx, info: CmdInfo): void {
  jc.acc.flags.add("dynamic_code");
  if (code.value === null) {
    addEngine(jc, "cmd.dynamic_code", shortCode(code.raw));
    return;
  }
  addEngine(jc, "cmd.dynamic_code", shortCode(code.value));
  scanCode(code.value, l, nested(jc), info);
}

// ---------- 코드 검사 ----------

const STRING_LIT = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;

/** 셸로 넘어가는 호출. 뒤따르는 문자열 또는 [리스트]를 셸 명령으로 본다 */
const SHELL_CALL =
  /(?:os\.system|os\.popen|subprocess\.\w+|commands\.getoutput|pty\.spawn|execSync|execFileSync|spawnSync|exec|execFile|spawn|system|shell_exec|passthru|popen|proc_open|IO\.popen|Open3\.\w+|do shell script)\s*\(?\s*(\[[^\]]*\]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;

/** awk: "cmd" | getline, print | "cmd" */
const AWK_PIPE = /"((?:\\.|[^"\\])*)"\s*\|\s*getline|\|\s*"((?:\\.|[^"\\])*)"/g;

export function scanCode(code: string, l: string, jc: JudgeCtx, info: CmdInfo): void {
  jc.acc.flags.add("dynamic_code");
  scanTokens(code, jc);
  for (const lit of literals(code, l)) scanPathLiteral(lit, jc, info);
  for (const shell of shellStrings(code, l)) mergeInfo(info, judgeScript(shell, jc));
}

function scanTokens(code: string, jc: JudgeCtx): void {
  for (const t of jc.rules.file.code_tokens) {
    const hit = t.tokens.find((tok) => code.includes(tok));
    if (hit)
      addFinding(jc, {
        grade: t.grade,
        ruleId: t.id,
        reason: `${t.reason}: "${hit}"`,
        allowKey: null,
      });
  }
}

function literals(code: string, l: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(STRING_LIT)) {
    const isBacktick = m[3] !== undefined;
    if (isBacktick && l !== "node" && l !== "bun" && l !== "deno") continue;
    out.push(unescapeLit(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  return out;
}

function scanPathLiteral(lit: string, jc: JudgeCtx, info: CmdInfo): void {
  const v = lit.replace(/^\$HOME(?=\/|$)/, "~");
  if (!/^(~|\/)/.test(v)) return;
  const abs = normalizePath(v, jc.base);
  if (abs) judgePath(jc, abs, "read", true, info);
}

function shellStrings(code: string, l: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(SHELL_CALL)) out.push(callArgToShell(m[1] ?? ""));
  if (l === "perl" || l === "ruby" || l === "php") {
    for (const m of code.matchAll(/`((?:\\.|[^`\\])*)`|qx\{([^}]*)\}|%x\(([^)]*)\)/g)) {
      out.push(unescapeLit(m[1] ?? m[2] ?? m[3] ?? ""));
    }
  }
  if (l === "awk") {
    for (const m of code.matchAll(AWK_PIPE)) out.push(unescapeLit(m[1] ?? m[2] ?? ""));
  }
  return out.filter((s) => s.trim().length > 0);
}

/** 문자열이면 그대로, [리스트]면 각 원소를 따옴표로 감싸 이어 붙인다 */
function callArgToShell(arg: string): string {
  if (!arg.startsWith("[")) return unescapeLit(arg.slice(1, -1));
  const items = [...arg.matchAll(STRING_LIT)].map((m) => unescapeLit(m[1] ?? m[2] ?? m[3] ?? ""));
  return items.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
}

function unescapeLit(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

// ---------- awk ----------

const AWK_WITH_VALUE = new Set(["-F", "-v", "-f"]);

export const awkHandler: HandlerFn = (jc, { args, info }) => {
  const progFile = args.findIndex((a) => a.value === "-f");
  const rest = skipAwkOptions(args);
  const program = progFile >= 0 ? null : rest[0];
  const files = progFile >= 0 ? rest : rest.slice(1);
  for (const f of files) judgeWordPaths(jc, f, "read", false, info);
  if (progFile >= 0) {
    const pf = args[progFile + 1];
    if (pf) judgeExecFile(jc, pf, info, "interpreter");
    return;
  }
  if (!program) return;
  const text = program.value;
  if (text === null) {
    addEngine(jc, "cmd.dynamic_code", shortCode(program.raw));
    return;
  }
  if (/system\s*\(|\|\s*getline|\|&|print[^;}]*[|>]/.test(text)) {
    addEngine(jc, "cmd.dynamic_code", shortCode(text));
    for (const m of text.matchAll(/system\s*\(\s*"((?:\\.|[^"\\])*)"/g)) {
      mergeInfo(info, judgeScript(unescapeLit(m[1] ?? ""), nested(jc)));
    }
    scanCode(text, "awk", nested(jc), info);
  }
};

function skipAwkOptions(args: Word[]): Word[] {
  let i = 0;
  while (i < args.length) {
    const v = args[i]?.value ?? "";
    if (AWK_WITH_VALUE.has(v)) i += 2;
    else if (/^-[Fv]./.test(v) || v === "--") i += 1;
    else break;
  }
  return args.slice(i);
}

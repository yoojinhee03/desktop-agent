// 나중에·다른 곳에서 실행되는 명령: crontab/at 예약, git 설정에 넣는 명령, docker 마운트
// 실행 시점에는 정책 엔진을 거치지 않으므로, 등록하는 지금 그 내용을 판정한다.
import type { Word } from "../../parse/model.ts";
import { normalizePath } from "../../paths.ts";
import { operands } from "../match.ts";
import { judgeWordPaths } from "../path-judge.ts";
import { judgeScript } from "../script.ts";
import { addEngine, type CmdInfo, type JudgeCtx, mergeInfo, nested } from "../state.ts";
import { stdinTextOf } from "./exec.ts";
import { type HandlerFn, syntheticWord } from "./types.ts";

// ---------- crontab, at, batch ----------

export const schedulerHandler: HandlerFn = (jc, { cmd, name, args, info }) => {
  if (name === "crontab" && args.some((a) => a.value === "-l" || a.value === "-r")) return;
  const file = operands(args).find((w) => w.value !== "-");
  const text = name === "crontab" && file ? fileText(file, jc) : stdinTextOf(cmd, jc);
  if (text === null) {
    addEngine(jc, "cmd.shell.dynamic", `${name}에 넘기는 내용을 미리 알 수 없음`);
    return;
  }
  const commands = name === "crontab" ? cronCommands(text) : [text];
  for (const c of commands) judgeLater(c, jc, info);
};

function fileText(w: Word, jc: JudgeCtx): string | null {
  const abs = w.value === null ? null : normalizePath(w.value, jc.base);
  if (abs === null) return null;
  return jc.pending.has(abs) ? (jc.pending.get(abs) ?? null) : jc.ctx.fs.readText(abs);
}

/** crontab 줄에서 일정 부분을 떼고 명령만 남긴다 (주석·변수 줄 제외) */
function cronCommands(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line === "" || line.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    const m = line.match(/^@\w+\s+(.*)$/) ?? line.match(/^(?:\S+\s+){5}(.*)$/);
    out.push(m?.[1] ?? line);
  }
  return out;
}

function judgeLater(code: string, jc: JudgeCtx, info: CmdInfo): void {
  mergeInfo(info, judgeScript(code, nested(jc)));
}

// ---------- git -c core.sshCommand=… / git config alias.x '!…' ----------

const EXEC_KEY =
  /^(core\.(sshCommand|pager|editor|fsmonitor|hooksPath|askPass)|alias\.[^=]+|credential\.helper|sequence\.editor|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|uploadpack\.packObjectsHook)$/i;

export const gitConfigHandler: HandlerFn = (jc, { args, info }) => {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === null || v === undefined) continue;
    const eq = v.indexOf("=");
    const key = eq > 0 ? v.slice(0, eq) : v;
    if (!EXEC_KEY.test(key)) continue;
    const value = eq > 0 ? v.slice(eq + 1) : (args[i + 1]?.value ?? null);
    if (value === null) {
      addEngine(jc, "cmd.shell.dynamic", `git 설정 ${key}`);
      continue;
    }
    if (key.toLowerCase() === "core.hookspath") {
      judgeWordPaths(jc, syntheticWord(value, args[i]), "write", true, info);
      continue;
    }
    judgeLater(value.replace(/^!/, ""), jc, info);
  }
};

// ---------- docker -v SRC:DST, --mount source=SRC ----------

export const dockerHandler: HandlerFn = (jc, { args, info }) => {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const v = w?.value;
    if (!w || v === null || v === undefined) continue;
    const next = args[i + 1];
    if ((v === "-v" || v === "--volume" || v === "--mount") && next) {
      mountSource(jc, v === "--mount" ? mountOpt(next.value) : volumeSrc(next.value), next, info);
      i++;
    } else if (v.startsWith("--volume=")) mountSource(jc, volumeSrc(v.slice(9)), w, info);
    else if (v.startsWith("--mount=")) mountSource(jc, mountOpt(v.slice(8)), w, info);
  }
};

function volumeSrc(v: string | null): string | null {
  if (v === null) return null;
  const src = v.split(":")[0] ?? "";
  return /^[/~.]/.test(src) ? src : "";
}

function mountOpt(v: string | null): string | null {
  if (v === null) return null;
  const m = v.match(/(?:^|,)(?:source|src)=([^,]+)/);
  return m?.[1] ?? "";
}

/** 컨테이너 안에서는 무엇이든 할 수 있으므로 마운트한 경로는 하위 전체를 읽는 것으로 본다 */
function mountSource(jc: JudgeCtx, src: string | null, like: Word, info: CmdInfo): void {
  if (src === "") return; // 이름 있는 볼륨: 호스트 경로가 아님
  judgeWordPaths(jc, syntheticWord(src, like), "read", true, info);
}

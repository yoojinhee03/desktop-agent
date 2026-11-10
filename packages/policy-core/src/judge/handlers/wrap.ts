// 다른 명령을 감싸는 명령(sudo, env, nohup …)과 xargs: 안쪽 명령을 꺼내 같은 규칙으로 판정한다
import type { Cmd, Word } from "../../parse/model.ts";
import { judgeArgv } from "../command.ts";
import { judgeWordPaths } from "../path-judge.ts";
import { noRewrite } from "../state.ts";
import { judgeShellString } from "./exec.ts";
import { type HandlerFn, innerCmd, syntheticWord } from "./types.ts";

// ---------- 감싸는 명령 (sudo, env, nohup …) ----------

interface WrapperSpec {
  /** 값을 받는 옵션 */
  withValue: string[];
  /** 옵션이 아닌 첫 인자 몇 개를 건너뛸지 (timeout의 시간 등) */
  skipOperands?: number;
  /** 이 옵션이 있으면 안쪽 명령이 없다 (command -v 등) */
  noInner?: string[];
}

const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    withValue: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"],
    noInner: ["-l", "-v", "-k", "-K"],
  },
  doas: { withValue: ["-u", "-C"] },
  su: { withValue: ["-c", "-s"] },
  env: { withValue: ["-u", "-P", "-C", "-S"] },
  command: { withValue: [], noInner: ["-v", "-V"] },
  builtin: { withValue: [] },
  exec: { withValue: ["-a"] },
  nohup: { withValue: [] },
  nice: { withValue: ["-n"] },
  time: { withValue: [] },
  timeout: { withValue: ["-s", "-k", "--signal", "--kill-after"], skipOperands: 1 },
  caffeinate: { withValue: ["-t", "-w"] },
  arch: { withValue: ["-arch"] },
  stdbuf: { withValue: ["-i", "-o", "-e"] },
  xcrun: { withValue: ["--sdk", "--toolchain"], noInner: ["--find", "-f", "--show-sdk-path"] },
  coproc: { withValue: [] },
};

export const wrapperHandler: HandlerFn = (jc, { cmd, name, args, info }) => {
  const spec = WRAPPERS[name] ?? { withValue: [] };
  if (args.some((a) => spec.noInner?.includes(a.value ?? ""))) return;
  const shellString = optionValue(args, name === "env" ? "-S" : "-c");
  if ((name === "su" || name === "env") && shellString) {
    judgeShellString(shellString, jc, info);
    return;
  }
  const inner = innerArgv(name, args, spec);
  if (inner.length > 0) judgeArgv(cmd, inner, jc, info);
};

function innerArgv(name: string, args: Word[], spec: WrapperSpec): Word[] {
  let i = 0;
  let skip = spec.skipOperands ?? 0;
  while (i < args.length) {
    const v = args[i]?.value;
    if (v === undefined || v === null) break;
    if (v === "--") return args.slice(i + 1);
    if (spec.withValue.includes(v)) i += 2;
    else if (v.startsWith("-") || (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v))) i += 1;
    else if (name === "su" && i === 0)
      i += 1; // su 사용자 이름
    else if (skip > 0) {
      skip--;
      i += 1;
    } else break;
  }
  return args.slice(i);
}

export function optionValue(args: Word[], opt: string): Word | null {
  const i = args.findIndex((a) => a.value === opt);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

// ---------- xargs ----------

const XARGS_WITH_VALUE = new Set(["-n", "-L", "-P", "-s", "-I", "-J", "-E", "-d", "-R", "-S"]);

export const xargsHandler: HandlerFn = (jc, { cmd, args, info }) => {
  let i = 0;
  while (i < args.length && args[i]?.value?.startsWith("-")) {
    i += XARGS_WITH_VALUE.has(args[i]?.value ?? "") ? 2 : 1;
  }
  const inner = args.slice(i);
  const fed = pipedPaths(cmd).map((p) => syntheticWord(p, args[0], true));
  // 입력으로 들어오는 경로는 안쪽 명령이 무엇이든 그 명령이 다루는 대상이다
  for (const w of fed) judgeWordPaths(jc, w, "read", true, info);
  const argv = inner.length > 0 ? inner : [syntheticWord("echo", args[0])];
  const tail = fed.length > 0 ? fed : [syntheticWord(null, args[0], true)];
  judgeArgv(innerCmd(cmd, argv), [...argv, ...tail], noRewrite(jc), info);
};

/** 파이프 앞 단계에 정적으로 보이는 경로 인자 (find 시작 위치, echo·ls 인자 등) */
function pipedPaths(cmd: Cmd): string[] {
  const out: string[] = [];
  for (const src of cmd.pipeFrom) {
    for (const w of src.argv.slice(1)) {
      const v = w.value;
      if (v && !v.startsWith("-") && (v.includes("/") || v.startsWith("~") || v === "."))
        out.push(v);
    }
  }
  return out;
}

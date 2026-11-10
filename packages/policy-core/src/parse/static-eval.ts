// 실행하지 않고도 출력이 정해지는 짧은 파이프라인을 계산한다.
// 목적: `echo cm0g… | base64 -d | sh`, `eval "$(printf …)"` 같은 인코딩 우회를 풀어서 다시 판정하는 것.
// 모르는 명령이 끼면 null(알 수 없음)을 돌려주고, 판정은 동적 실행(2등급 이상)으로 처리된다.
import type { Cmd } from "./model.ts";
import { staticArgs } from "./model.ts";

const MAX_DEPTH = 8;

export function evalStdout(cmd: Cmd, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const args = staticArgs(cmd.argv);
  if (!args || args.length === 0) return null;
  const [name, ...rest] = args;
  switch (name) {
    case "echo":
      return echo(rest);
    case "printf":
      return printf(rest);
    case "cat":
      return rest.length === 0 ? stdinOf(cmd, depth) : null;
    case "base64":
      return base64(rest, stdinOf(cmd, depth));
    case "xxd":
      return xxdReverse(rest, stdinOf(cmd, depth));
    case "rev":
      return mapLines(stdinOf(cmd, depth), (l) => [...l].reverse().join(""));
    default:
      return null;
  }
}

/** 히어스트링·히어독 본문, 없으면 파이프 앞 단계의 출력 */
export function stdinOf(cmd: Cmd, depth = 0): string | null {
  const body = cmd.redirects.find((r) => r.op === "<<<" || r.op === "<<");
  if (body) return body.body === null ? null : body.op === "<<<" ? `${body.body}\n` : body.body;
  if (cmd.pipeFrom.length !== 1) return null;
  const from = cmd.pipeFrom[0];
  return from ? evalStdout(from, depth + 1) : null;
}

function echo(args: string[]): string {
  let i = 0;
  let newline = true;
  while (args[i] && /^-[neE]+$/.test(args[i] ?? "")) {
    if (args[i]?.includes("n")) newline = false;
    i++;
  }
  return args.slice(i).join(" ") + (newline ? "\n" : "");
}

function printf(args: string[]): string | null {
  const [fmt, ...vals] = args;
  if (fmt === undefined) return null;
  if (/%[^sb%]/.test(fmt)) return null;
  let k = 0;
  const out = fmt.replace(/%([sb%])/g, (_m, c: string) => (c === "%" ? "%" : (vals[k++] ?? "")));
  return out.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function base64(args: string[], input: string | null): string | null {
  const decode = args.some((a) => /^(-[a-zA-Z]*[dD][a-zA-Z]*|--decode)$/.test(a));
  if (!decode || input === null) return null;
  const clean = input.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]*$/.test(clean)) return null;
  try {
    const bin = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
    return utf8(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null; // 올바른 base64가 아니면 정적으로 알 수 없음 → 동적 실행으로 판정
  }
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function xxdReverse(args: string[], input: string | null): string | null {
  const reverse = args.some((a) => /^-[a-z]*r/.test(a));
  const plain = args.some((a) => /^-[a-z]*p/.test(a) || a === "-ps" || a === "-plain");
  if (!reverse || !plain || input === null) return null;
  const hex = input.replace(/\s+/g, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return utf8(bytes);
}

function mapLines(input: string | null, fn: (line: string) => string): string | null {
  if (input === null) return null;
  return input
    .split("\n")
    .map((l, i, all) => (i === all.length - 1 && l === "" ? l : fn(l)))
    .join("\n");
}

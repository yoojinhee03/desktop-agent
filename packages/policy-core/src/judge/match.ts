// 명령 규칙의 match 조건 판정.
import type { Word } from "../parse/model.ts";
import type { CommandRule } from "../rules/schema.ts";

/** 시스템 경로 아래 실행 파일은 이름으로 판정한다 (/bin/rm → rm). 그 밖의 경로는 파일 실행 */
const SYSTEM_DIRS = /^\/(bin|sbin|usr|System|opt\/homebrew|Library\/Apple)\//;

export type NameInfo =
  | { kind: "name"; name: string }
  | { kind: "path"; path: string }
  | { kind: "dynamic" };

export function nameOf(word: Word | undefined): NameInfo {
  const v = word?.value;
  if (v === null || v === undefined) return { kind: "dynamic" };
  if (!v.includes("/")) return { kind: "name", name: v };
  if (SYSTEM_DIRS.test(v)) return { kind: "name", name: v.slice(v.lastIndexOf("/") + 1) };
  return { kind: "path", path: v };
}

/** 옵션이 아닌 인자 (-- 뒤는 모두 인자) */
export function operands(args: Word[]): Word[] {
  const out: Word[] = [];
  let rest = false;
  for (const w of args) {
    if (!rest && w.value === "--") {
      rest = true;
      continue;
    }
    if (!rest && w.value !== null && w.value.startsWith("-") && w.value !== "-") continue;
    out.push(w);
  }
  return out;
}

/** 값을 받는 옵션 (서브커맨드를 찾을 때 건너뛴다) */
const OPTION_VALUES: Record<string, string[]> = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"],
  npm: ["--prefix", "-C", "--workspace", "-w"],
  pnpm: ["--filter", "-F", "-C", "--dir"],
  docker: ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"],
  security: ["-k"],
};

export function subcommandOf(name: string, args: Array<string | null>): string | null {
  const withValue = OPTION_VALUES[name] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === null || a === undefined) return null;
    if (withValue.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

export function hasFlag(args: Array<string | null>, flag: string): boolean {
  if (flag.startsWith("--")) return args.some((a) => a === flag || a?.startsWith(`${flag}=`));
  if (flag.length === 2) {
    const letter = flag[1] ?? "";
    return args.some((a) => a !== null && /^-[A-Za-z0-9]+$/.test(a) && a.slice(1).includes(letter));
  }
  return args.includes(flag);
}

export function matchRule(rule: CommandRule, name: string, args: Array<string | null>): boolean {
  const m = rule.match;
  const commands = typeof m.command === "string" ? [m.command] : m.command;
  if (!commands.includes(name)) return false;
  const known = args.filter((a): a is string => a !== null);
  if (m.no_args && args.length > 0) return false;
  if (m.sole_arg_any && !(args.length === 1 && m.sole_arg_any.includes(known[0] ?? "")))
    return false;
  if (m.unless_sole_arg && args.length === 1 && m.unless_sole_arg.includes(known[0] ?? ""))
    return false;
  if (m.subcommand && !m.subcommand.includes(subcommandOf(name, args) ?? "")) return false;
  if (m.args_any && !m.args_any.some((x) => known.includes(x))) return false;
  if (m.args_prefix_any && !m.args_prefix_any.some((p) => known.some((a) => a.startsWith(p))))
    return false;
  if (m.args_regex_any && !m.args_regex_any.some((re) => known.some((a) => new RegExp(re).test(a))))
    return false;
  if (m.flags_any && !m.flags_any.some((f) => hasFlag(args, f))) return false;
  return true;
}

/** 맞는 규칙들. fallback 규칙은 다른 규칙이 하나도 없을 때만 */
export function matchedRules(
  rules: CommandRule[],
  name: string,
  args: Array<string | null>,
): CommandRule[] {
  const hits = rules.filter((r) => matchRule(r, name, args));
  const primary = hits.filter((r) => !r.fallback);
  return primary.length > 0 ? primary : hits;
}

/** -a(아카이브)가 재귀를 뜻하는 명령 */
const ARCHIVE_RECURSIVE = new Set(["cp", "rsync", "ditto"]);

export function isRecursive(name: string, args: Array<string | null>): boolean {
  if (hasFlag(args, "-r") || hasFlag(args, "-R") || hasFlag(args, "--recursive")) return true;
  return ARCHIVE_RECURSIVE.has(name) && hasFlag(args, "-a");
}

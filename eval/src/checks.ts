// 실행 후 상태 검증. 에이전트가 "했다"고 말한 것이 아니라 실제로 바뀐 것을 본다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { expandHome } from "./fixtures.ts";
import type { ScenarioCheck } from "./schema.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckContext {
  home: string;
  reply: string;
}

type CheckOf<T extends ScenarioCheck["type"]> = Extract<ScenarioCheck, { type: T }>;
type Handlers = {
  [T in ScenarioCheck["type"]]: (
    c: CheckOf<T>,
    ctx: CheckContext,
  ) => CheckResult | Promise<CheckResult>;
};

const result = (name: string, ok: boolean, detail = ""): CheckResult => ({ name, ok, detail });

async function countGlob(pattern: string, home: string): Promise<number> {
  let n = 0;
  for await (const _ of glob(expandHome(pattern, home))) n += 1;
  return n;
}

function runShellCheck(command: string, home: string): string {
  const opts = { cwd: home, encoding: "utf8" as const, timeout: 30_000 };
  return execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], opts).trim();
}

const HANDLERS: Handlers = {
  missing: (c, { home }) => result(`없어야 함: ${c.path}`, !existsSync(expandHome(c.path, home))),
  exists: (c, { home }) => result(`있어야 함: ${c.path}`, existsSync(expandHome(c.path, home))),
  file_contains: (c, { home }) => {
    const text = readFileSync(expandHome(c.path, home), "utf8");
    return result(`${c.path}에 "${c.text}"`, text.includes(c.text));
  },
  glob_count: async (c, { home }) => {
    const n = await countGlob(c.pattern, home);
    return result(`${c.pattern} 개수 = ${c.count}`, n === c.count, `실제 ${n}개`);
  },
  in_trash: (c, { home }) => {
    const n = readdirSync(join(home, ".Trash")).filter((f) => f.startsWith(c.name_prefix)).length;
    return result(
      `휴지통에 ${c.name_prefix}* ${c.min_count}개 이상`,
      n >= c.min_count,
      `실제 ${n}개`,
    );
  },
  shell: (c, { home }) => {
    const out = runShellCheck(c.command, home);
    return result(`셸 확인: ${c.command}`, out === c.stdout, `출력 ${JSON.stringify(out)}`);
  },
  reply_mentions: (c, { reply }) => {
    const missing = c.all_of.filter((words) => !words.some((w) => reply.includes(w)));
    return result(
      "답변의 안내 문구",
      missing.length === 0,
      missing.length ? `빠짐: ${JSON.stringify(missing)}` : "",
    );
  },
};

function evaluate(c: ScenarioCheck, ctx: CheckContext): CheckResult | Promise<CheckResult> {
  const handler = HANDLERS[c.type] as (
    c: ScenarioCheck,
    ctx: CheckContext,
  ) => CheckResult | Promise<CheckResult>;
  return handler(c, ctx);
}

/** 검증 하나가 오류를 내도(권한 없음 등) 나머지는 계속 확인하고, 그 검증은 실패로 기록한다 */
export async function runChecks(
  checks: ScenarioCheck[],
  ctx: CheckContext,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks) {
    try {
      out.push(await evaluate(c, ctx));
    } catch (err) {
      out.push(
        result(
          `${c.type} 검증`,
          false,
          `오류: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  return out;
}

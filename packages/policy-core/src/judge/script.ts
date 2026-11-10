// 셸 문자열 하나(원래 명령, bash -c 안쪽, 스크립트 파일 내용)를 판정한다.
import { extractScript } from "../parse/extract.ts";
import type { Cmd } from "../parse/model.ts";
import { newEnv } from "../parse/model.ts";
import { judgeCmd } from "./command.ts";
import { addEngine, type CmdInfo, emptyInfo, type JudgeCtx, mergeInfo } from "./state.ts";

export function judgeScript(source: string, jc: JudgeCtx): CmdInfo {
  const total = emptyInfo();
  if (jc.depth > jc.rules.file.defaults.max_shell_depth) {
    addEngine(jc, "cmd.shell.depth_exceeded", `${jc.depth}단계`);
    jc.acc.flags.add("unparseable");
    return total;
  }
  const env = newEnv({
    HOME: jc.ctx.home,
    ...(jc.base.cwd ? { PWD: jc.base.cwd } : {}),
    ...positionalVars(jc),
  });
  const script = extractScript(source, env);
  if (script.error) {
    addEngine(jc, "parse.unparseable");
    jc.acc.flags.add("unparseable");
  }
  if (script.forkBomb) addEngine(jc, "block.fork_bomb");
  if (env.vars.get("HOME") !== jc.ctx.home)
    addEngine(jc, "path.dynamic", "HOME 변경 이후의 ~ 경로");
  for (const cmd of script.cmds) mergeInfo(total, judgeCmd(cmd, jc));
  checkExfil(script.cmds, jc);
  return total;
}

function positionalVars(jc: JudgeCtx): Record<string, string> {
  const vars: Record<string, string> = {};
  jc.positional.forEach((v, i) => {
    vars[String(i)] = v;
  });
  if (jc.positional.length > 1) vars["@"] = jc.positional.slice(1).join(" ");
  return vars;
}

/**
 * 자격증명 유출: 외부로 보낼 수 있는 명령(curl, nc, 스크립트 언어 등)에
 * 자격증명을 읽은 명령의 출력이 흘러들어가면 차단한다.
 * 흐름: 파이프 앞 단계, 인자 안의 $( )·<( ), 출력 리다이렉션의 >( ).
 */
function checkExfil(cmds: Cmd[], jc: JudgeCtx): void {
  const feeders = outputFeeders(cmds);
  for (const n of cmds) {
    if (!jc.infos.get(n)?.network) continue;
    const sources = upstream(n, feeders);
    const leak = [n, ...sources].find((c) => jc.infos.get(c)?.credRead);
    if (leak) addEngine(jc, "block.credential_exfil", jc.infos.get(leak)?.readPaths.join(", "));
  }
}

/** >( cmd ) 안의 명령 → 그 리다이렉션을 가진 명령 */
function outputFeeders(cmds: Cmd[]): Map<Cmd, Cmd[]> {
  const map = new Map<Cmd, Cmd[]>();
  for (const c of cmds) {
    for (const r of c.redirects) {
      for (const inner of r.target?.inner ?? []) map.set(inner, [...(map.get(inner) ?? []), c]);
    }
  }
  return map;
}

function upstream(n: Cmd, feeders: Map<Cmd, Cmd[]>): Cmd[] {
  const seen = new Set<Cmd>([n]);
  const stack = directSources(n, feeders);
  const out: Cmd[] = [];
  while (stack.length > 0) {
    const c = stack.pop();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...directSources(c, feeders));
  }
  return out;
}

function directSources(c: Cmd, feeders: Map<Cmd, Cmd[]>): Cmd[] {
  const fromWords = c.argv.flatMap((w) => w.inner);
  const fromRedirectIn = c.redirects.flatMap((r) =>
    r.op.startsWith("<") ? (r.target?.inner ?? []) : [],
  );
  return [...c.pipeFrom, ...fromWords, ...fromRedirectIn, ...(feeders.get(c) ?? [])];
}

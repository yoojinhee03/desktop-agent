// 규칙 YAML을 읽고 zod로 검증한 뒤, 홈 경로에 맞춰 글로브를 컴파일한다.
import { parse as parseYaml } from "yaml";
import { type CompiledGlob, compileGlob } from "./glob.ts";
import {
  type CommandRule,
  type EngineRule,
  type PathClass,
  type RuleFile,
  RuleFileSchema,
} from "./schema.ts";

/** 코드 핸들러가 참조하는 엔진 규칙. 규칙 파일에 없으면 로드를 거부한다. */
export const REQUIRED_ENGINE_RULES = [
  "cmd.unclassified",
  "parse.unparseable",
  "cmd.dynamic_name",
  "path.dynamic",
  "cmd.shell.depth_exceeded",
  "cmd.shell.dynamic",
  "cmd.exec.script",
  "cmd.exec.agent_written",
  "cmd.remote_script",
  "cmd.dynamic_code",
  "cmd.rm.bulk",
  "cmd.rm.permanent",
  "cmd.find.unbounded",
  "net.upload",
  "net.download",
  "block.delete_home_or_root",
  "block.credential_exfil",
  "block.fork_bomb",
  "tool.unknown",
  "tool.web",
  "tool.file_read",
  "tool.file_write",
] as const;

export type EngineRuleId = (typeof REQUIRED_ENGINE_RULES)[number];

export class RuleFileError extends Error {
  constructor(message: string) {
    super(`규칙 파일 오류: ${message}`);
    this.name = "RuleFileError";
  }
}

export interface CompiledClass extends PathClass {
  compiled: CompiledGlob[];
  compiledExcept: CompiledGlob[];
}

export interface RuleSet {
  file: RuleFile;
  home: string;
  classes: CompiledClass[];
  commands: CommandRule[];
  network: CommandRule[];
  engine: Map<string, EngineRule>;
}

export function parseRules(yamlText: string): RuleFile {
  const result = RuleFileSchema.safeParse(parseYaml(yamlText));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new RuleFileError(issues.join("; "));
  }
  checkIntegrity(result.data);
  return result.data;
}

function checkIntegrity(file: RuleFile): void {
  const engineIds = new Set(file.engine.map((r) => r.id));
  const missing = REQUIRED_ENGINE_RULES.filter((id) => !engineIds.has(id));
  if (missing.length > 0) throw new RuleFileError(`engine 규칙 누락: ${missing.join(", ")}`);
  const all = [
    ...file.path_classes,
    ...file.commands,
    ...file.network,
    ...file.engine,
    ...file.code_tokens,
  ];
  const seen = new Set<string>();
  for (const r of all) {
    if (seen.has(r.id)) throw new RuleFileError(`규칙 ID 중복: ${r.id}`);
    seen.add(r.id);
  }
  for (const r of [...file.commands, ...file.network]) {
    for (const re of r.match.args_regex_any ?? []) compileRegex(r.id, re);
  }
}

function compileRegex(id: string, re: string): void {
  try {
    new RegExp(re);
  } catch {
    throw new RuleFileError(`${id}: 정규식이 올바르지 않음 (${re})`);
  }
}

const cache = new Map<string, RuleSet>();

/** 홈 경로·에이전트 내부 경로에 맞춰 컴파일한다. 같은 조합은 캐시한다. */
export function compileRules(file: RuleFile, home: string, agentPaths: string[]): RuleSet {
  const key = `${home}\u0000${agentPaths.join("\u0000")}`;
  const hit = cache.get(key);
  if (hit && hit.file === file) return hit;
  const set: RuleSet = {
    file,
    home,
    classes: file.path_classes.map((c) => compileClass(c, home, agentPaths)),
    commands: file.commands,
    network: file.network,
    engine: new Map(file.engine.map((r) => [r.id, r])),
  };
  cache.set(key, set);
  return set;
}

function compileClass(c: PathClass, home: string, agentPaths: string[]): CompiledClass {
  const globs = c.id === "path.agent_internal" ? [...c.globs, ...agentPaths] : c.globs;
  return {
    ...c,
    compiled: globs.map((g) => compileGlob(g, home)),
    compiledExcept: c.except.map((g) => compileGlob(g, home)),
  };
}

export function engineRule(rules: RuleSet, id: EngineRuleId): EngineRule {
  const r = rules.engine.get(id);
  if (!r) throw new RuleFileError(`engine 규칙 없음: ${id}`);
  return r;
}

// 정책 엔진 진입점. ready()로 규칙·파서를 한 번 불러오고, decide()는 동기 순수 함수로 판정한다.
// (파일 시스템 조회는 DecideContext.fs로 주입된다)
import { defaultContext } from "./context.ts";
import { gradeRank, maxOf } from "./grade.ts";
import type { Acc, Finding, JudgeCtx } from "./judge/state.ts";
import { newAcc } from "./judge/state.ts";
import { initParser, isParserReady, PolicyNotReadyError } from "./parse/parser.ts";
import { compileRules, parseRules } from "./rules/load.ts";
import type { RuleFile } from "./rules/schema.ts";
import { judgeTool } from "./tools.ts";
import type { DecideContext, Grade, PolicyAction, PolicyDecision, ToolCall } from "./types.ts";

export interface ReadyOptions {
  /** 규칙 YAML 내용. 생략하면 패키지의 rules/macos.yaml */
  rulesYaml?: string;
  /** tree-sitter-bash.wasm 경로 또는 내용. 생략하면 의존성에서 찾는다 */
  bashWasm?: string | Uint8Array;
}

let loaded: RuleFile | null = null;

/** 판정 전에 한 번 호출한다. 규칙 파일이 잘못됐으면 RuleFileError로 거부한다 */
export async function ready(options: ReadyOptions = {}): Promise<void> {
  const text = options.rulesYaml ?? (await defaultRulesText());
  const file = parseRules(text);
  await initParser(options.bashWasm);
  loaded = file;
}

async function defaultRulesText(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../rules/macos.yaml", import.meta.url), "utf8");
}

/**
 * 도구 호출 하나를 판정한다. ready() 전에 호출하면 PolicyNotReadyError를 던진다
 * (초기화 전에 판정 없이 실행되는 일을 막기 위함).
 */
export function decide(call: ToolCall, ctx?: DecideContext): PolicyDecision {
  if (!loaded || !isParserReady()) throw new PolicyNotReadyError();
  const c = ctx ?? defaultContext();
  const jc: JudgeCtx = {
    ctx: c,
    rules: compileRules(loaded, c.home, c.agentPaths),
    acc: newAcc(),
    depth: 0,
    rewritable: true,
    base: { home: c.home, cwd: c.cwd },
    pending: new Map(),
    infos: new Map(),
    permanentDelete: call.input.permanentDelete === true,
    positional: [],
    remote: new Set(),
  };
  const source = judgeTool(call, jc);
  return finalize(jc, source);
}

function finalize(jc: JudgeCtx, source: string | null): PolicyDecision {
  const acc = jc.acc;
  const findings = [...acc.findings].sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade));
  const grade = maxOf(findings.map((f) => f.grade));
  const rewrite = source !== null && grade !== "block" ? applyRewrites(source, acc) : undefined;
  const decision: PolicyDecision = {
    grade,
    action: actionFor(grade, rewrite !== undefined),
    ruleIds: unique(findings.map((f) => f.ruleId)),
    reasons: unique(
      findings.filter((f) => f.grade !== 0 || findings.length === 1).map((f) => f.reason),
    ),
    flags: [...acc.flags],
    effects: { writes: [...acc.writes], tainted: [...acc.tainted] },
  };
  if (rewrite !== undefined) decision.rewrite = rewrite;
  const preview = previewOf(acc);
  if (preview) decision.preview = preview;
  if (jc.ctx.session.externalContent && gradeRank(grade) >= 2)
    decision.flags.push("after_external_content");
  applySessionAllow(decision, findings, jc);
  return decision;
}

function actionFor(grade: Grade, rewritten: boolean): PolicyAction {
  if (grade === "block") return "deny";
  if (grade === 2 || grade === 3) return "ask";
  return rewritten ? "rewrite" : "allow";
}

/** 2등급이고 근거가 모두 세션 허용 대상이면 allowKeys를 채우고, 이미 허용된 키면 자동 실행 */
function applySessionAllow(d: PolicyDecision, findings: Finding[], jc: JudgeCtx): void {
  if (d.grade !== 2) return;
  const top = findings.filter((f) => f.grade === 2);
  const keys = top.map((f) => f.allowKey);
  if (keys.some((k) => k === null)) return;
  d.allowKeys = unique(keys as string[]);
  if (d.allowKeys.every((k) => jc.ctx.session.allowKeys.includes(k))) {
    d.action = d.rewrite !== undefined ? "rewrite" : "allow";
    d.reasons.push("이번 세션에서 허용한 종류라 자동 실행");
  }
}

function applyRewrites(source: string, acc: Acc): string | undefined {
  if (acc.rewrites.length === 0) return undefined;
  let out = source;
  let limit = Number.POSITIVE_INFINITY;
  for (const r of [...acc.rewrites].sort((a, b) => b.start - a.start)) {
    if (r.end > limit) continue; // 겹치는 치환은 바깥 것만
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    limit = r.start;
  }
  return out;
}

function previewOf(acc: Acc): PolicyDecision["preview"] | undefined {
  if (acc.previewPaths.size === 0 && !acc.count.measured) return undefined;
  const p: NonNullable<PolicyDecision["preview"]> = { paths: [...acc.previewPaths].slice(0, 100) };
  if (acc.count.measured) {
    p.fileCount = acc.count.files;
    p.totalBytes = acc.count.bytes;
  }
  return p;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

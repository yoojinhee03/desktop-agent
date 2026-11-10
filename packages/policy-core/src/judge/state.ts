// 판정 중에 쌓이는 근거·치환·미리보기. 한 번의 decide() 호출 안에서만 쓴다.
import type { Cmd } from "../parse/model.ts";
import type { PathBase } from "../paths.ts";
import { type EngineRuleId, engineRule, type RuleSet } from "../rules/load.ts";
import type { DecideContext, Grade, PolicyFlag } from "../types.ts";

export interface Finding {
  grade: Grade;
  ruleId: string;
  reason: string;
  /** 세션 허용 키. null이면 세션 허용 대상이 아님 */
  allowKey: string | null;
}

export interface Rewrite {
  start: number;
  end: number;
  text: string;
}

export interface Acc {
  findings: Finding[];
  flags: Set<PolicyFlag>;
  rewrites: Rewrite[];
  previewPaths: Set<string>;
  count: { files: number; bytes: number; measured: boolean };
  writes: Set<string>;
  tainted: Set<string>;
}

/** 명령 하나를 판정한 뒤 남기는 요약. 자격증명 유출·오염 추적에 쓴다 */
export interface CmdInfo {
  credRead: boolean;
  network: boolean;
  readPaths: string[];
  writes: string[];
}

export interface JudgeCtx {
  ctx: DecideContext;
  rules: RuleSet;
  acc: Acc;
  /** 셸 문자열 중첩 깊이. 0이 원래 명령 */
  depth: number;
  /** 원문을 잘라 바꿀 수 있는지 (중첩 문자열 안의 명령은 치환 불가) */
  rewritable: boolean;
  base: PathBase;
  /** 이번 호출에서 앞서 쓴 파일과 그 내용 (모르면 null) */
  pending: Map<string, string | null>;
  infos: Map<Cmd, CmdInfo>;
  permanentDelete: boolean;
  /** sh -c 'code' 이름 인자… 의 위치 인자 ($0, $1 …) */
  positional: string[];
  /** 이번 호출에서 내려받아 쓴 파일 (curl -o 등). 실행하면 원격 스크립트로 본다 */
  remote: Set<string>;
}

export function newAcc(): Acc {
  return {
    findings: [],
    flags: new Set(),
    rewrites: [],
    previewPaths: new Set(),
    count: { files: 0, bytes: 0, measured: false },
    writes: new Set(),
    tainted: new Set(),
  };
}

export function emptyInfo(): CmdInfo {
  return { credRead: false, network: false, readPaths: [], writes: [] };
}

export function mergeInfo(into: CmdInfo, from: CmdInfo): void {
  into.credRead ||= from.credRead;
  into.network ||= from.network;
  into.readPaths.push(...from.readPaths);
  into.writes.push(...from.writes);
}

export function addFinding(jc: JudgeCtx, f: Finding): void {
  jc.acc.findings.push(f);
}

/** 엔진 규칙(코드가 내는 판정)을 근거로 추가한다. detail은 승인 창에 덧붙일 설명 */
export function addEngine(jc: JudgeCtx, id: EngineRuleId, detail?: string, scope?: string): void {
  const r = engineRule(jc.rules, id);
  addFinding(jc, {
    grade: r.grade,
    ruleId: r.id,
    reason: detail ? `${r.reason}: ${detail}` : r.reason,
    allowKey: r.session_allow ? (scope ? `${r.id}:${scope}` : r.id) : null,
  });
}

/** 중첩 판정용 문맥 (bash -c 문자열, 스크립트 파일 내용 등) */
export function nested(jc: JudgeCtx): JudgeCtx {
  return { ...jc, depth: jc.depth + 1, rewritable: false, base: { ...jc.base }, positional: [] };
}

/** 같은 깊이지만 원문 치환이 안 되는 자리 (xargs·find -exec 안쪽 명령 등) */
export function noRewrite(jc: JudgeCtx): JudgeCtx {
  return { ...jc, rewritable: false };
}

export function shortCode(code: string): string {
  const one = code.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}…` : one;
}

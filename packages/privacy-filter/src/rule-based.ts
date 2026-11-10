import { SECRET_PATTERNS, type SecretPattern } from "./patterns.ts";
import type { FilteredOutput, MaskingRecord, PrivacyFilter, ToolOutput } from "./types.ts";

/** local_only 내용을 보내지 않을 때 모델에게 주는 안내 */
export const WITHHELD_NOTICE =
  "[전송 안 함] 자격증명 등 로컬 처리만 허용된 경로의 내용입니다. 로컬 모델이 없어 요약도 할 수 없습니다. " +
  "사용자에게 직접 확인하도록 안내하세요.";

export function maskTag(kind: string): string {
  return `[MASKED:${kind}]`;
}

function applyPattern(text: string, p: SecretPattern): { text: string; count: number } {
  let count = 0;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(new RegExp(p.regex.source, p.regex.flags))) {
    const replaced = p.replace(m, maskTag(p.kind));
    if (replaced === null) continue;
    const start = m.index ?? 0;
    out += text.slice(last, start) + replaced;
    last = start + m[0].length;
    count += 1;
  }
  return { text: out + text.slice(last), count };
}

function addCount(records: MaskingRecord[], kind: string, count: number): void {
  if (count === 0) return;
  const existing = records.find((r) => r.kind === kind);
  if (existing) existing.count += count;
  else records.push({ kind, count });
}

/** 규칙 마스킹만 한다 (원문 → 마스킹된 문자열 + 종류별 개수) */
export function maskSecrets(text: string): { text: string; maskings: MaskingRecord[] } {
  const maskings: MaskingRecord[] = [];
  let current = text;
  for (const p of SECRET_PATTERNS) {
    const r = applyPattern(current, p);
    current = r.text;
    addCount(maskings, p.kind, r.count);
  }
  return { text: current, maskings };
}

/** 객체 안의 모든 문자열 값을 마스킹한다 (감사 로그에 도구 입력을 남길 때) */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      maskDeep(v),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/**
 * M1 필터: 규칙 마스킹을 항상 하고, local_only(자격증명·브라우저 프로필 원문) 내용은 아예 보내지 않는다.
 * M2에서 LocalModel을 붙이면 local_only 내용은 로컬 요약으로 바꿔 보낸다 (HybridFilter).
 */
export class RuleBasedFilter implements PrivacyFilter {
  async process(input: ToolOutput): Promise<FilteredOutput> {
    if (input.flags.includes("local_only")) {
      return { text: WITHHELD_NOTICE, maskings: [], withheld: "local_only" };
    }
    const { text, maskings } = maskSecrets(input.text);
    return { text, maskings, withheld: null };
  }
}

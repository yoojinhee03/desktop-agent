import type { CallDiff, ChangeKind } from "./compare.ts";

export type ReplaySummary = Record<ChangeKind, number> & { total: number };

export function summarizeReplay(diffs: CallDiff[]): ReplaySummary {
  const s: ReplaySummary = {
    total: diffs.length,
    same: 0,
    stricter: 0,
    looser: 0,
    changed: 0,
    error: 0,
  };
  for (const d of diffs) s[d.kind] += 1;
  return s;
}

const LABEL: Record<ChangeKind, string> = {
  same: "같음",
  stricter: "더 엄격",
  looser: "더 느슨 ⚠",
  changed: "규칙·처리 변경",
  error: "재판정 오류",
};

function describeInput(input: Record<string, unknown>): string {
  const text = typeof input.command === "string" ? input.command : JSON.stringify(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function side(grade: unknown, action: unknown, rules: string[]): string {
  return `${String(grade)}/${String(action)} [${rules.join(",")}]`;
}

export function formatDiff(d: CallDiff): string {
  const before = side(d.before.grade, d.before.action, d.before.ruleIds);
  const after = d.after ? side(d.after.grade, d.after.action, d.after.ruleIds) : `오류: ${d.error}`;
  return `${LABEL[d.kind]}  ${d.toolName} ${describeInput(d.input)}\n    ${before}\n  → ${after}`;
}

export function formatReplaySummary(s: ReplaySummary): string {
  const parts = (Object.keys(LABEL) as ChangeKind[]).map((k) => `${LABEL[k]} ${s[k]}`);
  return `재생 ${s.total}건: ${parts.join(" · ")}`;
}

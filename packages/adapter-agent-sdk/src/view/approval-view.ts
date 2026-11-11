// 승인 창에 판정과 함께 보여줄 내용 (설계: 승인 창 표시 — 실제 명령, diff, 규칙 ID).
// 화면 표시 전용이다. 파일 내용이 담기므로 감사 로그에는 남기지 않는다.
import { readFile } from "node:fs/promises";
import type { PolicyDecision, ToolCall } from "@desktop-agent/policy-core";
import { type FileContext, resolvePath } from "../mcp/files.ts";
import { agentToolName } from "../mcp/server.ts";
import { unifiedDiff } from "./line-diff.ts";

export interface ApprovalView {
  /** 바뀔 내용. 정책 엔진의 preview.diff가 있으면 그것, 없으면 파일 도구에 한해 어댑터가 계산한다 */
  diff?: string;
  /** diff를 만들지 못한 이유 (예: 바꿀 문자열이 여러 곳) */
  note?: string;
}

const MAX_DIFF_SOURCE = 512 * 1024;

/** 없는 파일은 빈 내용(새 파일), 너무 크거나 이진 파일이면 null */
async function currentText(abs: string): Promise<string | null> {
  try {
    const buf = await readFile(abs);
    if (buf.length > MAX_DIFF_SOURCE || buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 도구가 실행되면 파일에 남을 내용. 계산할 수 없으면 이유를 돌려준다 */
function nextText(call: ToolCall, before: string): string | { note: string } {
  const { content, old_text: oldText, new_text: newText } = call.input;
  if (call.toolName === agentToolName("write_file")) {
    return str(content) ?? { note: "쓸 내용이 문자열이 아님" };
  }
  const o = str(oldText);
  const n = str(newText);
  if (o === null || n === null) return { note: "바꿀 문자열이 없음" };
  const hits = before.split(o).length - 1;
  if (hits !== 1) return { note: `바꿀 문자열이 ${hits}곳에서 발견됨 (도구가 실행을 거부함)` };
  return before.replace(o, () => n);
}

const FILE_TOOLS = new Set([agentToolName("write_file"), agentToolName("edit_file")]);

async function fileDiff(call: ToolCall, ctx: FileContext): Promise<ApprovalView> {
  const path = str(call.input.path);
  if (path === null) return { note: "파일 경로가 없음" };
  const before = await currentText(resolvePath(path, ctx));
  if (before === null) return { note: "기존 파일이 크거나 이진 파일이라 diff를 만들지 않음" };
  const after = nextText(call, before);
  if (typeof after !== "string") return after;
  const diff = unifiedDiff(before, after);
  return diff === "" ? { note: "내용이 바뀌지 않음" } : { diff };
}

export async function buildApprovalView(
  call: ToolCall,
  decision: PolicyDecision,
  ctx: FileContext,
): Promise<ApprovalView> {
  if (decision.preview?.diff) return { diff: decision.preview.diff };
  if (!FILE_TOOLS.has(call.toolName)) return {};
  try {
    return await fileDiff(call, ctx);
  } catch (err) {
    return { note: `diff를 만들지 못함: ${err instanceof Error ? err.message : String(err)}` };
  }
}

import { createInterface } from "node:readline/promises";
import type { PolicyDecision, PolicyFlag, ToolCall } from "@desktop-agent/policy-core";

/** approved_for_session: "이번 세션에서 같은 종류 허용" (2등급이고 세션 허용 키가 있을 때만) */
export type ApprovalAnswer = "approved" | "approved_for_session" | "rejected";

/** ask 판정을 사람에게(또는 테스트 스크립트에) 물어보는 자리. M3에서 Electron 승인 창으로 바뀐다. */
export interface Approver {
  /** 감사 로그의 승인자 필드에 남는 이름 (예: user:terminal, script:sandbox-readonly) */
  readonly id: string;
  ask(call: ToolCall, decision: PolicyDecision): Promise<ApprovalAnswer>;
}

export function describeCall(call: ToolCall): string {
  const command = call.input.command;
  return typeof command === "string" ? command : JSON.stringify(call.input);
}

/** 설계: 세션 허용은 2등급만, 그리고 판정 근거가 모두 세션 허용 대상일 때(allowKeys가 채워짐)만 */
export function canAllowForSession(decision: PolicyDecision): boolean {
  return decision.grade === 2 && (decision.allowKeys?.length ?? 0) > 0;
}

/** 승인 창에 보일 표시 문구 (설계: 외부 내용을 읽은 뒤의 2등급 이상 작업은 "외부 내용 읽은 후"로 알린다) */
const FLAG_LABELS: Record<PolicyFlag, string> = {
  after_external_content: "⚠ 외부 내용 읽은 후 (웹 페이지 등의 지시로 생긴 요청일 수 있음)",
  unparseable: "명령을 완전히 분석하지 못함",
  llm_judged: "모델 보조 판정",
  local_only: "자격증명 등 로컬 처리만 허용된 내용",
  dynamic_code: "동적 코드 실행 (코드를 그대로 확인하세요)",
};

export function describeFlags(flags: readonly PolicyFlag[]): string[] {
  return flags.map((f) => FLAG_LABELS[f] ?? f);
}

function promptLines(call: ToolCall, decision: PolicyDecision): string[] {
  const lines = [
    `\n[승인 요청] 등급 ${decision.grade} · ${decision.ruleIds.join(", ")}`,
    `  도구: ${call.toolName}`,
    `  내용: ${describeCall(call)}`,
    `  사유: ${decision.reasons.join(" / ")}`,
  ];
  for (const label of describeFlags(decision.flags)) lines.push(`  표시: ${label}`);
  const p = decision.preview;
  if (p) {
    const size = p.totalBytes === undefined ? "" : `, ${p.totalBytes}바이트`;
    lines.push(
      `  대상: ${p.fileCount ?? p.paths.length}개${size} · ${p.paths.slice(0, 5).join(", ")}`,
    );
  }
  return lines;
}

function parseAnswer(raw: string, sessionAllowed: boolean): ApprovalAnswer {
  const answer = raw.trim().toLowerCase();
  if (answer === "y" || answer === "yes") return "approved";
  if (answer === "s" && sessionAllowed) return "approved_for_session";
  return "rejected"; // 알아들을 수 없는 답은 거절
}

function questionText(sessionAllowed: boolean): string {
  const choices = sessionAllowed ? "y: 실행 / s: 이번 세션에서 같은 종류 허용 / n: 거절" : "y/n";
  return `  실행할까요? (${choices}) `;
}

/** 터미널 승인. y는 이번만 승인, s는 세션 허용(가능할 때만), 그 밖의 답은 모두 거절이다. */
export function createTerminalApprover(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Approver {
  return {
    id: "user:terminal",
    async ask(call, decision) {
      const rl = createInterface({ input, output });
      try {
        output.write(`${promptLines(call, decision).join("\n")}\n`);
        const sessionAllowed = canAllowForSession(decision);
        return parseAnswer(await rl.question(questionText(sessionAllowed)), sessionAllowed);
      } finally {
        rl.close();
      }
    },
  };
}

/** 테스트·리플레이용: 판단 함수를 그대로 승인 결과로 쓴다. */
export function createScriptedApprover(
  id: string,
  judge: (call: ToolCall, decision: PolicyDecision) => ApprovalAnswer,
): Approver {
  return { id: `script:${id}`, ask: async (call, decision) => judge(call, decision) };
}

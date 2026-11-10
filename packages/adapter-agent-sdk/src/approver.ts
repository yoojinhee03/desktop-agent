import { createInterface } from "node:readline/promises";
import type { PolicyDecision, ToolCall } from "@desktop-agent/policy-core";

export type ApprovalAnswer = "approved" | "rejected";

/** ask 판정을 사람에게(또는 테스트 스크립트에) 물어보는 자리. M3에서 Electron 승인 창으로 바뀐다. */
export interface Approver {
  ask(call: ToolCall, decision: PolicyDecision): Promise<ApprovalAnswer>;
}

export function describeCall(call: ToolCall): string {
  const command = call.input.command;
  return typeof command === "string" ? command : JSON.stringify(call.input);
}

/** 터미널 y/n 승인. y 또는 yes만 승인이고 나머지는 모두 거절이다. */
export function createTerminalApprover(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Approver {
  return {
    async ask(call, decision) {
      const rl = createInterface({ input, output });
      try {
        output.write(`\n[승인 요청] 등급 ${decision.grade} · ${decision.ruleIds.join(", ")}\n`);
        output.write(`  도구: ${call.toolName}\n  내용: ${describeCall(call)}\n`);
        output.write(`  사유: ${decision.reasons.join(" / ")}\n`);
        const answer = (await rl.question("  실행할까요? (y/n) ")).trim().toLowerCase();
        return answer === "y" || answer === "yes" ? "approved" : "rejected";
      } finally {
        rl.close();
      }
    },
  };
}

/** 테스트·리플레이용: 판단 함수를 그대로 승인 결과로 쓴다. */
export function createScriptedApprover(
  judge: (call: ToolCall, decision: PolicyDecision) => ApprovalAnswer,
): Approver {
  return { ask: async (call, decision) => judge(call, decision) };
}

import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { PolicyDecision, ToolCall } from "@desktop-agent/policy-core";
import type { ApprovalAnswer, Approver } from "./approver.ts";

export type Outcome = "auto_allowed" | "approved" | "rejected" | "denied" | "rewritten" | "error";

/** 판정 한 건의 기록. 감사 로그·커버리지 확인에 쓴다. */
export interface GateEvent {
  toolUseId: string;
  call: ToolCall;
  decision: PolicyDecision | null;
  outcome: Outcome;
  executedInput: Record<string, unknown> | null;
  error?: string;
}

export interface PolicyGateOptions {
  decide: (call: ToolCall) => PolicyDecision;
  approver: Approver;
  onEvent?: (event: GateEvent) => void | Promise<void>;
}

export interface PolicyGate {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool: CanUseTool;
}

type Verdict = Pick<GateEvent, "outcome" | "executedInput">;

const APPROVAL_OUTCOME: Record<ApprovalAnswer, Outcome> = {
  approved: "approved",
  rejected: "rejected",
};

async function resolve(
  call: ToolCall,
  decision: PolicyDecision,
  approver: Approver,
): Promise<Verdict> {
  switch (decision.action) {
    case "allow":
      return { outcome: "auto_allowed", executedInput: call.input };
    case "deny":
      return { outcome: "denied", executedInput: null };
    case "rewrite":
      // 치환 명령이 없으면 원래 명령을 실행하지 않는다 (fail closed)
      if (decision.rewrite === undefined) return { outcome: "denied", executedInput: null };
      return { outcome: "rewritten", executedInput: { ...call.input, command: decision.rewrite } };
    case "ask": {
      const outcome = APPROVAL_OUTCOME[await approver.ask(call, decision)];
      return { outcome, executedInput: outcome === "approved" ? call.input : null };
    }
  }
}

function toHookOutput(event: GateEvent): SyncHookJSONOutput {
  const allowed = event.executedInput !== null;
  const reason = event.error ?? event.decision?.reasons.join(" / ") ?? "정책 엔진 판정 없음";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      permissionDecisionReason: allowed
        ? reason
        : `정책 엔진이 거부함 (${event.outcome}): ${reason}`,
      ...(event.outcome === "rewritten" && event.executedInput
        ? { updatedInput: event.executedInput }
        : {}),
    },
  };
}

async function judge(options: PolicyGateOptions, toolUseId: string, call: ToolCall) {
  try {
    const decision = options.decide(call);
    const verdict = await resolve(call, decision, options.approver);
    return { toolUseId, call, decision, ...verdict };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      toolUseId,
      call,
      decision: null,
      outcome: "error" as const,
      executedInput: null,
      error,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Agent SDK 연결 지점. 모든 도구 호출이 PreToolUse 훅에서 decide()를 거친다.
 * canUseTool은 SDK가 따로 권한을 물을 때만 불리므로(읽기 도구·허용 규칙은 건너뜀) 1차 관문으로 쓰지 않고,
 * 훅을 우회해 도달한 호출을 거부하는 안전망으로만 둔다.
 */
export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  const preToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const call: ToolCall = { toolName: input.tool_name, input: asRecord(input.tool_input) };
    const event = await judge(options, toolUseId ?? input.tool_use_id, call);
    await options.onEvent?.(event);
    return toHookOutput(event);
  };
  const canUseTool: CanUseTool = async (toolName) => ({
    behavior: "deny",
    message: `정책 엔진 훅을 거치지 않은 권한 요청이라 거부함: ${toolName}`,
  });
  return {
    hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }] },
    canUseTool,
  };
}

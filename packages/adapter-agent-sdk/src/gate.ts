import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  DecideContext,
  PolicyDecision,
  SessionState,
  ToolCall,
} from "@desktop-agent/policy-core";
import type { ApprovalAnswer, Approver } from "./approver.ts";
import type { ApprovalLedger } from "./mcp/ledger.ts";
import { type BaseContext, SessionStore } from "./session-store.ts";

export type Outcome =
  | "auto_allowed"
  | "approved"
  | "approved_for_session"
  | "rejected"
  | "denied"
  | "rewritten"
  | "error";

/** 판정 한 건의 기록. 감사 로그·커버리지 확인에 쓴다. */
export interface GateEvent {
  toolUseId: string;
  call: ToolCall;
  decision: PolicyDecision | null;
  outcome: Outcome;
  /** 실행을 결정한 주체: policy(자동 허용·거부·치환) 또는 승인자 id */
  decidedBy: string;
  executedInput: Record<string, unknown> | null;
  error?: string;
}

export interface PolicyGateOptions {
  decide: (call: ToolCall, ctx: DecideContext) => PolicyDecision;
  context: BaseContext;
  approver: Approver;
  initialSession?: SessionState;
  /** 자체 MCP 도구용 승인 장부. 허용한 입력을 여기 올려야 도구가 실행된다 */
  ledger?: ApprovalLedger;
  onEvent?: (event: GateEvent) => void | Promise<void>;
}

export interface PolicyGate {
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool: CanUseTool;
  session(): SessionState;
  endUserRequest(): void;
}

type Verdict = Pick<GateEvent, "outcome" | "executedInput" | "decidedBy">;

const POLICY = "policy";

async function ask(call: ToolCall, decision: PolicyDecision, approver: Approver): Promise<Verdict> {
  const answer: ApprovalAnswer = await approver.ask(call, decision);
  const executedInput = answer === "rejected" ? null : call.input;
  return { outcome: answer, executedInput, decidedBy: approver.id };
}

async function resolve(call: ToolCall, d: PolicyDecision, approver: Approver): Promise<Verdict> {
  switch (d.action) {
    case "allow":
      return { outcome: "auto_allowed", executedInput: call.input, decidedBy: POLICY };
    case "deny":
      return { outcome: "denied", executedInput: null, decidedBy: POLICY };
    case "rewrite":
      // 치환 명령이 없으면 원래 명령을 실행하지 않는다 (fail closed)
      if (d.rewrite === undefined) {
        return { outcome: "denied", executedInput: null, decidedBy: POLICY };
      }
      return {
        outcome: "rewritten",
        executedInput: { ...call.input, command: d.rewrite },
        decidedBy: POLICY,
      };
    case "ask":
      return ask(call, d, approver);
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

/** 실행이 허용됐으면 세션 상태와 승인 장부에 반영한다 */
function applyVerdict(options: PolicyGateOptions, store: SessionStore, event: GateEvent): void {
  const { decision, executedInput } = event;
  if (!decision) return;
  if (event.outcome === "approved_for_session") store.allowForSession(decision);
  if (executedInput === null) return;
  store.applyExecuted(decision);
  const { toolUseId, call } = event;
  options.ledger?.grant({ toolUseId, toolName: call.toolName, input: executedInput, decision });
}

function errorEvent(toolUseId: string, call: ToolCall, err: unknown): GateEvent {
  const error = err instanceof Error ? err.message : String(err);
  return {
    toolUseId,
    call,
    decision: null,
    outcome: "error",
    decidedBy: POLICY,
    executedInput: null,
    error,
  };
}

async function judge(
  options: PolicyGateOptions,
  store: SessionStore,
  toolUseId: string,
  call: ToolCall,
): Promise<GateEvent> {
  try {
    const decision = options.decide(call, store.context());
    const verdict = await resolve(call, decision, options.approver);
    const event: GateEvent = { toolUseId, call, decision, ...verdict };
    applyVerdict(options, store, event);
    return event;
  } catch (err) {
    return errorEvent(toolUseId, call, err);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Agent SDK 연결 지점. 모든 도구 호출이 PreToolUse 훅에서 decide()를 거친다.
 * canUseTool은 SDK가 따로 권한을 물을 때만 불리므로(읽기 도구·허용 규칙은 건너뜀) 1차 관문으로 쓰지 않고,
 * 훅을 우회해 도달한 호출을 거부하는 안전망으로만 둔다.
 * 호출 쪽은 정책 엔진의 ready()를 먼저 끝내야 한다. 안 그러면 decide()가 던지고 모든 호출이 거부된다.
 */
function preToolUseHook(options: PolicyGateOptions, store: SessionStore): HookCallback {
  return async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const call: ToolCall = { toolName: input.tool_name, input: asRecord(input.tool_input) };
    const id = toolUseId ?? input.tool_use_id;
    return store.serialize(async () => {
      const event = await judge(options, store, id, call);
      await options.onEvent?.(event);
      return toHookOutput(event);
    });
  };
}

const canUseTool: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `정책 엔진 훅을 거치지 않은 권한 요청이라 거부함: ${toolName}`,
});

export function createPolicyGate(options: PolicyGateOptions): PolicyGate {
  const store = new SessionStore(options.context, options.initialSession);
  const preToolUse = preToolUseHook(options, store);
  return {
    hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }] },
    canUseTool,
    session: () => store.snapshot(),
    endUserRequest: () => store.endUserRequest(),
  };
}

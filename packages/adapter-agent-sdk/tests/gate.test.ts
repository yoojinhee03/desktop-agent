import type { HookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { PolicyDecision } from "@desktop-agent/policy-core";
import { describe, expect, it } from "vitest";
import { createPolicyGate, createScriptedApprover, type GateEvent } from "../src/index.ts";

const base: PolicyDecision = { grade: 2, action: "ask", ruleIds: ["t"], reasons: ["r"], flags: [] };

function preToolUse(command: string): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "tu_1",
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/tmp",
  } as HookInput;
}

async function run(decision: PolicyDecision | Error, answer: "approved" | "rejected" = "approved") {
  const events: GateEvent[] = [];
  const gate = createPolicyGate({
    decide: () => {
      if (decision instanceof Error) throw decision;
      return decision;
    },
    approver: createScriptedApprover(() => answer),
    onEvent: (e) => {
      events.push(e);
    },
  });
  const hook = gate.hooks.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("PreToolUse 훅이 없음");
  const out = (await hook(preToolUse("ls"), "tu_1", {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
  const specific = out.hookSpecificOutput;
  if (specific?.hookEventName !== "PreToolUse") throw new Error("PreToolUse 출력이 아님");
  return { specific, events };
}

describe("createPolicyGate", () => {
  it("ask + 승인이면 allow, 이벤트를 남긴다", async () => {
    const { specific, events } = await run(base, "approved");
    expect(specific.permissionDecision).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe("approved");
    expect(events[0]?.call).toEqual({ toolName: "Bash", input: { command: "ls" } });
  });

  it("ask + 거절이면 deny", async () => {
    const { specific } = await run(base, "rejected");
    expect(specific.permissionDecision).toBe("deny");
  });

  it("deny 판정은 승인을 묻지 않고 거부", async () => {
    const { specific, events } = await run({ ...base, grade: "block", action: "deny" }, "approved");
    expect(specific.permissionDecision).toBe("deny");
    expect(events[0]?.outcome).toBe("denied");
  });

  it("rewrite는 치환된 명령으로 실행", async () => {
    const { specific } = await run({ ...base, grade: 1, action: "rewrite", rewrite: "trash a" });
    expect(specific.permissionDecision).toBe("allow");
    expect(specific.updatedInput).toEqual({ command: "trash a" });
  });

  it("rewrite 명령이 비어 있으면 원래 명령을 실행하지 않음", async () => {
    const { specific } = await run({ ...base, grade: 1, action: "rewrite" });
    expect(specific.permissionDecision).toBe("deny");
  });

  it("decide()가 예외를 던지면 거부 (fail closed)", async () => {
    const { specific, events } = await run(new Error("규칙 로드 실패"));
    expect(specific.permissionDecision).toBe("deny");
    expect(events[0]?.outcome).toBe("error");
  });

  it("canUseTool 안전망은 항상 거부", async () => {
    const gate = createPolicyGate({
      decide: () => base,
      approver: createScriptedApprover(() => "approved"),
    });
    const result = await gate.canUseTool("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "x",
    } as never);
    expect(result?.behavior).toBe("deny");
  });
});

import type { HookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { nodeFs } from "@desktop-agent/policy-core";
import type { BaseContext, PolicyGate } from "../src/index.ts";

export function baseContext(cwd = "/tmp", home = "/Users/tester"): BaseContext {
  return { home, cwd, fs: nodeFs, agentPaths: [] };
}

export function preToolUse(toolName: string, toolInput: Record<string, unknown>, id = "tu_1") {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: id,
    session_id: "s",
    transcript_path: "/dev/null",
    cwd: "/tmp",
  } as HookInput;
}

/** 게이트의 PreToolUse 훅을 한 번 부르고 PreToolUse 출력을 돌려준다 */
export async function callHook(gate: PolicyGate, input: HookInput) {
  const hook = gate.hooks.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("PreToolUse 훅이 없음");
  const id = input.hook_event_name === "PreToolUse" ? input.tool_use_id : undefined;
  const out = (await hook(input, id, {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
  const specific = out.hookSpecificOutput;
  if (specific?.hookEventName !== "PreToolUse") throw new Error("PreToolUse 출력이 아님");
  return specific;
}

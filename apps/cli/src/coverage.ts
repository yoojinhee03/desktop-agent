import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";

/** 모델이 요청한 도구 호출과 정책 엔진을 거친 호출을 대조한다. */
export class CoverageTracker {
  private readonly requested = new Map<string, string>(); // tool_use_id → 도구 이름
  private readonly gated = new Set<string>();

  recordMessage(message: SDKMessage): void {
    if (message.type !== "assistant") return;
    for (const block of message.message.content) {
      if (block.type === "tool_use") this.requested.set(block.id, block.name);
    }
  }

  recordGate(event: GateEvent): void {
    this.gated.add(event.toolUseId);
  }

  report(): { total: number; bash: number; missing: string[] } {
    const ids = [...this.requested.keys()];
    const bash = ids.filter((id) => this.requested.get(id) === "Bash").length;
    const missing = ids.filter((id) => !this.gated.has(id));
    return { total: ids.length, bash, missing };
  }
}

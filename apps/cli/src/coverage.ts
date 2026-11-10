import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FilterEvent, GateEvent } from "@desktop-agent/adapter-agent-sdk";

export interface CoverageReport {
  total: number;
  shell: number;
  /** 정책 엔진(decide)을 거치지 않은 호출 */
  ungated: string[];
  /** 실행이 허용됐는데 프라이버시 필터를 거치지 않은 호출 */
  unfiltered: string[];
}

const SHELL = /(^Bash$|__shell$)/;
/** 출력이 프라이버시 필터를 거쳐야 하는 도구: 자체 MCP 도구 (웹 도구 결과는 공개된 외부 내용이라 대상 아님) */
const FILTERED = /^mcp__agent__/;

/** 모델이 요청한 도구 호출을 정책 엔진 판정·프라이버시 필터 기록과 대조한다. */
export class CoverageTracker {
  private readonly requested = new Map<string, string>(); // tool_use_id → 도구 이름
  private readonly gated = new Set<string>();
  private readonly allowed = new Set<string>();
  private readonly filtered = new Set<string>();

  recordMessage(message: SDKMessage): void {
    if (message.type !== "assistant") return;
    for (const block of message.message.content) {
      if (block.type === "tool_use") this.requested.set(block.id, block.name);
    }
  }

  recordGate(event: GateEvent): void {
    this.gated.add(event.toolUseId);
    const mustFilter = FILTERED.test(event.call.toolName);
    if (event.executedInput !== null && mustFilter) this.allowed.add(event.toolUseId);
  }

  recordFilter(event: FilterEvent): void {
    if (event.toolUseId) this.filtered.add(event.toolUseId);
  }

  report(): CoverageReport {
    const ids = [...this.requested.keys()];
    return {
      total: ids.length,
      shell: ids.filter((id) => SHELL.test(this.requested.get(id) ?? "")).length,
      ungated: ids.filter((id) => !this.gated.has(id)),
      unfiltered: [...this.allowed].filter((id) => !this.filtered.has(id)),
    };
  }
}

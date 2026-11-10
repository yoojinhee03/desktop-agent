import type { PolicyDecision } from "@desktop-agent/policy-core";

/** 게이트가 실행을 허용한 호출 한 건 */
export interface Grant {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  decision: PolicyDecision;
}

/** 키 순서를 고정한 JSON (같은 입력이면 같은 키) */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in input).map((k) => [k, input[k]]));
}

/**
 * 승인 장부: PreToolUse 게이트가 허용한 입력을 올리고, MCP 도구는 같은 입력이 장부에 있을 때만 실행한다.
 * 훅이 어떤 이유로 불리지 않아도 도구가 판정 없이 실행되지 않게 하는 두 번째 잠금이다.
 * 비교는 도구 스키마에 있는 키만 쓴다 (SDK가 스키마 밖 키를 버릴 수 있으므로).
 */
export class ApprovalLedger {
  private readonly grants = new Map<string, Grant[]>();

  constructor(private readonly schemaKeys: (toolName: string) => readonly string[] | null) {}

  private key(toolName: string, input: Record<string, unknown>): string | null {
    const keys = this.schemaKeys(toolName);
    return keys ? `${toolName}\u0000${stable(pick(input, keys))}` : null;
  }

  /** 장부가 관리하는 도구(자체 MCP 도구)면 올리고, 아니면 무시한다 */
  grant(g: Grant): void {
    const k = this.key(g.toolName, g.input);
    if (k === null) return;
    this.grants.set(k, [...(this.grants.get(k) ?? []), g]);
  }

  /** 실행 직전에 꺼낸다. 한 번 승인은 한 번 실행에만 쓰인다 */
  take(toolName: string, args: Record<string, unknown>): Grant | null {
    const k = this.key(toolName, args);
    const list = k === null ? undefined : this.grants.get(k);
    if (!k || !list || list.length === 0) return null;
    const [first, ...rest] = list;
    if (rest.length > 0) this.grants.set(k, rest);
    else this.grants.delete(k);
    return first ?? null;
  }
}

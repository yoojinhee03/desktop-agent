// 한 번의 요청에 필요한 부품 조립: 감사 로그, 정책 게이트, 승인 장부, 자체 MCP 도구, 커버리지 대조.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalLedger,
  type Approver,
  agentSchemaKeys,
  createAgentToolServer,
  createPolicyGate,
  type FilterEvent,
  type GateEvent,
  type PolicyGate,
} from "@desktop-agent/adapter-agent-sdk";
import type { AuditLog } from "@desktop-agent/audit-log";
import { decide, nodeFs } from "@desktop-agent/policy-core";
import { RuleBasedFilter } from "@desktop-agent/privacy-filter";
import { agentPathGlobs, openVerifiedLog, toDecisionEntry, toFilterEntry } from "./audit.ts";
import { CoverageTracker } from "./coverage.ts";
import { formatFilterEvent, formatGateEvent } from "./log.ts";

export interface Runtime {
  audit: AuditLog;
  coverage: CoverageTracker;
  gate: PolicyGate;
  server: McpSdkServerConfigWithInstance;
}

export interface RuntimeOptions {
  prompt: string;
  cwd: string;
  dataDir: string;
  approver: Approver;
  log: (line: string) => void;
}

function gateRecorder(o: RuntimeOptions, rt: Pick<Runtime, "audit" | "coverage">, id: string) {
  return (e: GateEvent) => {
    rt.audit.append(toDecisionEntry(id, e));
    rt.coverage.recordGate(e);
    o.log(formatGateEvent(e));
  };
}

function filterRecorder(o: RuntimeOptions, rt: Pick<Runtime, "audit" | "coverage">, id: string) {
  return (e: FilterEvent) => {
    rt.audit.append(toFilterEntry(id, e));
    rt.coverage.recordFilter(e);
    const line = formatFilterEvent(e);
    if (line) o.log(line);
  };
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const audit = openVerifiedLog(o.dataDir, o.log);
  const coverage = new CoverageTracker();
  const requestId = randomUUID();
  audit.append({ kind: "request", requestId, prompt: o.prompt });
  const home = homedir();
  const context = { home, cwd: o.cwd, fs: nodeFs, agentPaths: agentPathGlobs(o.dataDir) };
  const ledger = new ApprovalLedger(agentSchemaKeys);
  const onEvent = gateRecorder(o, { audit, coverage }, requestId);
  const gate = createPolicyGate({ decide, context, approver: o.approver, ledger, onEvent });
  const onFilter = filterRecorder(o, { audit, coverage }, requestId);
  const filter = new RuleBasedFilter();
  const server = createAgentToolServer({ cwd: o.cwd, home, ledger, filter, onFilter });
  return { audit, coverage, gate, server };
}

import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";
import { runAgent } from "@desktop-agent/cli/agent";
import { createScenarioApprover } from "./approver.ts";
import { type CheckResult, runChecks } from "./checks.ts";
import { evaluateExpect, executedCommands, type RunRecord } from "./expect.ts";
import { runBefore, writeFixtures } from "./fixtures.ts";
import type { Scenario } from "./schema.ts";

export interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  checks: CheckResult[];
  approvals: number;
  executed: string[];
  costUsd: number;
  turns: number;
  durationMs: number;
}

export interface RunScenarioOptions {
  home: string;
  dataDir: string;
  log: (line: string) => void;
}

function prepare(s: Scenario, home: string): void {
  runBefore(s.before, home);
  writeFixtures(s.fixtures, home);
}

async function execute(s: Scenario, o: RunScenarioOptions) {
  const { approver, records } = createScenarioApprover(s.approve?.rules ?? []);
  const events: GateEvent[] = [];
  const res = await runAgent({
    prompt: s.request,
    cwd: o.home,
    dataDir: o.dataDir,
    approver,
    log: o.log,
    onGate: (e) => events.push(e),
  });
  const record: RunRecord = {
    events,
    approvals: records,
    agentOk: res.ok,
    ungated: res.coverage.ungated.length,
    unfiltered: res.coverage.unfiltered.length,
  };
  return { res, record };
}

/** 시나리오 하나: 준비 → 에이전트 실행 → 기대 동작·결과 검증 */
export async function runScenario(s: Scenario, o: RunScenarioOptions): Promise<ScenarioResult> {
  const started = Date.now();
  prepare(s, o.home);
  const { res, record } = await execute(s, o);
  const checks = [
    ...evaluateExpect(s, record),
    ...(await runChecks(s.checks, { home: o.home, reply: res.resultText })),
  ];
  return {
    id: s.id,
    title: s.title,
    passed: checks.every((c) => c.ok),
    checks,
    approvals: record.approvals.length,
    executed: executedCommands(record.events),
    costUsd: res.costUsd,
    turns: res.turns,
    durationMs: Date.now() - started,
  };
}

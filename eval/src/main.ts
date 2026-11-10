// 대표 시나리오 실행기. 사용법: pnpm --filter eval scenarios [--dry-run] [--only <id>]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "@desktop-agent/cli/audit";
import { loadScenarios } from "./load.ts";
import { formatResult, formatSummary, summarize } from "./report.ts";
import { runScenario, type ScenarioResult } from "./run-scenario.ts";
import type { Scenario } from "./schema.ts";
import { checkVirtualMachine, notVmMessage } from "./vm.ts";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
  },
});

const RESULTS_DIR = new URL("../results/", import.meta.url).pathname;
const log = (line: string) => process.stderr.write(`${line}\n`);

function select(all: Scenario[]): Scenario[] {
  const picked = values.only ? all.filter((s) => s.id === values.only) : all;
  if (picked.length === 0) throw new Error(`시나리오 없음: ${values.only}`);
  return picked;
}

function printPlan(scenarios: Scenario[]): void {
  for (const s of scenarios) {
    log(`- ${s.id}: ${s.title}`);
    log(`    요청: ${s.request}`);
    log(
      `    준비 파일 ${s.fixtures.length}종, 검증 ${s.checks.length}개, 승인 ${s.expect.min_approvals}~${s.expect.max_approvals}회`,
    );
  }
}

function saveResults(results: ScenarioResult[]): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  writeFileSync(file, JSON.stringify({ summary: summarize(results), results }, null, 2));
  return file;
}

async function runAll(scenarios: Scenario[]): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    log(`\n=== ${s.id} ===`);
    results.push(await runScenario(s, { home: homedir(), dataDir: dataDir(false), log }));
  }
  return results;
}

async function main(): Promise<number> {
  const scenarios = select(await loadScenarios());
  if (values["dry-run"]) {
    printPlan(scenarios);
    return 0;
  }
  const vm = checkVirtualMachine();
  if (!vm.vm) {
    log(notVmMessage(vm));
    return 2;
  }
  const results = await runAll(scenarios);
  log("");
  for (const r of results) for (const line of formatResult(r)) log(line);
  log(formatSummary(summarize(results)));
  log(`결과: ${saveResults(results)}`);
  return results.every((r) => r.passed) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`[eval] 실패: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);

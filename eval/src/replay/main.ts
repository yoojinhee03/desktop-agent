// 정책 재생. 사용법:
//   pnpm --filter eval replay [--sandbox | --db <audit.sqlite>] [--rules <후보 규칙.yaml>] [--json] [--fail-on-looser]
// 감사 로그를 읽기 전용으로 열어, 기록된 도구 호출을 지금(또는 후보) 규칙으로 다시 판정하고 달라진 것만 보고한다.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openAuditLogReadOnly } from "@desktop-agent/audit-log";
import { agentPathGlobs, dataDir } from "@desktop-agent/cli/audit";
import { decide, nodeFs, ready } from "@desktop-agent/policy-core";
import type { CallDiff } from "./compare.ts";
import { groupByRequest, type RecordedRequest } from "./group.ts";
import { replayAll } from "./replay.ts";
import { formatDiff, formatReplaySummary, summarizeReplay } from "./report.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    sandbox: { type: "boolean", default: false },
    rules: { type: "string" },
    json: { type: "boolean", default: false },
    "fail-on-looser": { type: "boolean", default: false },
  },
});

const log = (line: string) => process.stderr.write(`${line}\n`);

function dbPath(): { dir: string; file: string } {
  if (values.db) return { dir: join(values.db, ".."), file: values.db };
  const dir = dataDir(values.sandbox);
  return { dir, file: join(dir, "audit.sqlite") };
}

function readRequests(file: string): RecordedRequest[] {
  const reader = openAuditLogReadOnly(file);
  try {
    const v = reader.verify();
    if (v.ok) log(`[replay] 해시 체인 검증 통과 (${v.rows}행) · ${file}`);
    else
      log(
        `[replay] 경고: 해시 체인이 ${v.brokenAtId}번 행에서 깨짐 (${v.reason}). 결과를 신뢰하기 어렵습니다.`,
      );
    return groupByRequest(reader.entries());
  } finally {
    reader.close();
  }
}

async function prepareEngine(): Promise<void> {
  if (!values.rules) return ready();
  log(`[replay] 후보 규칙: ${values.rules}`);
  return ready({ rulesYaml: readFileSync(values.rules, "utf8") });
}

function print(diffs: CallDiff[]): void {
  const summary = summarizeReplay(diffs);
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ summary, diffs: diffs.filter((d) => d.kind !== "same") }, null, 2)}\n`,
    );
    return;
  }
  for (const d of diffs) if (d.kind !== "same") log(formatDiff(d));
  log(formatReplaySummary(summary));
}

async function main(): Promise<number> {
  const { dir, file } = dbPath();
  if (!existsSync(file)) throw new Error(`감사 로그가 없음: ${file}`);
  const requests = readRequests(file);
  await prepareEngine();
  const base = { fs: nodeFs, agentPaths: agentPathGlobs(dir) };
  const diffs = replayAll(requests, {
    decide,
    base,
    fallbackHome: homedir(),
    fallbackCwd: homedir(),
  });
  print(diffs);
  const looser = diffs.filter((d) => d.kind === "looser").length;
  return values["fail-on-looser"] && looser > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`[replay] 실패: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

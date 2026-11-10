// 정책 재생: 실제 정책 엔진으로 다시 판정 (명령 실행·모델 호출 없음)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionEntry, RecordedEntry } from "@desktop-agent/audit-log";
import { decide, nodeFs, type PolicyDecision, ready } from "@desktop-agent/policy-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify } from "../src/replay/compare.ts";
import { groupByRequest, type RecordedRequest } from "../src/replay/group.ts";
import { replayAll } from "../src/replay/replay.ts";
import { summarizeReplay } from "../src/replay/report.ts";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "replay-home-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const RULES_FILE = new URL("../../packages/policy-core/rules/macos.yaml", import.meta.url);

function call(command: string, over: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    kind: "decision",
    requestId: "r1",
    toolUseId: command,
    toolName: "mcp__agent__shell",
    input: { command },
    grade: 1,
    action: "allow",
    ruleIds: ["cmd.open.app", "cmd.open"],
    reasons: [],
    flags: [],
    outcome: "auto_allowed",
    decidedBy: "policy",
    executedInput: { command },
    ...over,
  };
}

const request = (calls: DecisionEntry[]): RecordedRequest => ({
  requestId: "r1",
  prompt: "p",
  home,
  cwd: home,
  calls,
});

const options = () => ({
  decide,
  base: { fs: nodeFs, agentPaths: [] },
  fallbackHome: home,
  fallbackCwd: home,
});

describe("기록 묶기", () => {
  it("요청별로 묶고 판정 환경을 붙이며, 필터 기록은 건너뛴다", () => {
    const entries: RecordedEntry[] = [
      {
        id: 1,
        createdAt: "t",
        entry: { kind: "request", requestId: "r1", prompt: "p", cwd: "/w", home: "/h" },
      },
      { id: 2, createdAt: "t", entry: call("ls") },
      {
        id: 3,
        createdAt: "t",
        entry: {
          kind: "filter",
          requestId: "r1",
          toolUseId: "ls",
          toolName: "x",
          maskings: [],
          withheld: null,
        },
      },
    ];
    const [r] = groupByRequest(entries);
    expect(r).toMatchObject({ requestId: "r1", cwd: "/w", home: "/h" });
    expect(r?.calls).toHaveLength(1);
  });
});

describe("변화 분류", () => {
  const d = (
    grade: PolicyDecision["grade"],
    action: PolicyDecision["action"],
    ruleIds: string[],
  ) => ({
    grade,
    action,
    ruleIds,
    reasons: [],
    flags: [],
  });
  it("등급이 오르면 stricter, 내리면 looser, 같고 규칙만 다르면 changed", () => {
    const before = call("x", { grade: 2, action: "ask", ruleIds: ["a"] });
    expect(classify(before, d(3, "ask", ["a"]))).toBe("stricter");
    expect(classify(before, d(1, "allow", ["a"]))).toBe("looser");
    expect(classify(before, d(2, "ask", ["b"]))).toBe("changed");
    expect(classify(before, d(2, "ask", ["a"]))).toBe("same");
  });

  it("기록 당시 판정이 실패했으면(null) 가장 엄격했던 것(거부)으로 본다", () => {
    const failed = call("x", { grade: null, action: null, ruleIds: [] });
    // 지금 차단이면 등급은 같고 처리 방식만 생김 → 느슨해진 것이 아니다
    expect(classify(failed, d("block", "deny", ["cmd.block"]))).toBe("changed");
    // 지금 자동 실행이면 실제로 덜 막는 것이므로 looser
    expect(classify(failed, d(0, "allow", ["cmd.read"]))).toBe("looser");
  });
});

describe("현재 규칙으로 재생", () => {
  beforeAll(async () => {
    await ready();
  });

  it("같은 규칙이면 모두 같음", () => {
    const diffs = replayAll([request([call('open -a "Google Chrome"')])], options());
    expect(summarizeReplay(diffs)).toMatchObject({ total: 1, same: 1 });
  });

  it("세션 허용을 기록대로 되살려, 두 번째 호출의 자동 실행을 그대로 재현한다", () => {
    const brew = (id: string, over: Partial<DecisionEntry>) =>
      call("brew install jq", { toolUseId: id, grade: 2, ruleIds: ["cmd.brew.install"], ...over });
    const calls = [
      brew("t1", { action: "ask", outcome: "approved_for_session", decidedBy: "user:terminal" }),
      brew("t2", { action: "allow", outcome: "auto_allowed" }),
    ];
    const diffs = replayAll([request(calls)], options());
    expect(diffs.map((x) => x.kind)).toEqual(["same", "same"]);
  });
});

describe("후보 규칙으로 재생", () => {
  beforeAll(async () => {
    // 후보 규칙: 앱 실행(cmd.open.app)을 1등급 → 2등급으로 올린다
    const yaml = readFileSync(RULES_FILE, "utf8").replace(
      /(- id: cmd\.open\.app\n(?:.*\n)*?\s+grade:) 1/,
      "$1 2",
    );
    await ready({ rulesYaml: yaml });
  });
  afterAll(async () => {
    await ready();
  });

  it("규칙 변경이 기존 기록의 판정을 어떻게 바꾸는지 보고한다", () => {
    const diffs = replayAll([request([call('open -a "Google Chrome"')])], options());
    expect(diffs[0]?.kind).toBe("stricter");
    expect(diffs[0]?.after?.grade).toBe(2);
  });
});

// 시나리오 실행기 부품 테스트 (모델 호출·실제 홈 변경 없음, 임시 폴더만 사용)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateEvent } from "@desktop-agent/adapter-agent-sdk";
import type { PolicyDecision } from "@desktop-agent/policy-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScenarioApprover } from "../src/approver.ts";
import { runChecks } from "../src/checks.ts";
import { evaluateExpect, executedCommands, type RunRecord } from "../src/expect.ts";
import { expandHome, writeFixtures } from "../src/fixtures.ts";
import { loadScenarios, parseScenario } from "../src/load.ts";
import { summarize } from "../src/report.ts";
import type { ScenarioResult } from "../src/run-scenario.ts";
import { checkVirtualMachine } from "../src/vm.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "eval-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("시나리오 파일", () => {
  it("대표 시나리오 4개가 모두 형식 검사를 통과한다", async () => {
    const ids = (await loadScenarios()).map((s) => s.id);
    expect(ids).toEqual(["find-reveal", "delete-small", "delete-bulk", "env-var"]);
  });

  it("형식이 틀리면 파일 이름과 함께 거부한다", () => {
    expect(() =>
      parseScenario("id: Bad Id\ntitle: x\nrequest: y\nexpect: {}\n", "bad.yaml"),
    ).toThrow(/bad\.yaml/);
  });
});

describe("VM 확인", () => {
  it("kern.hv_vmm_present=1일 때만 VM", () => {
    expect(checkVirtualMachine(() => "1\n").vm).toBe(true);
    expect(checkVirtualMachine(() => "0\n").vm).toBe(false);
  });

  it("확인할 수 없으면 VM이 아닌 것으로 보고 이유를 남긴다", () => {
    const r = checkVirtualMachine(() => {
      throw new Error("sysctl 없음");
    });
    expect(r).toEqual({ vm: false, detail: expect.stringContaining("sysctl 없음") });
  });
});

describe("픽스처", () => {
  it("{n}과 count로 여러 파일을 만든다", () => {
    const made = writeFixtures([{ path: "~/Downloads/b/f-{n}.tmp", content: "x", count: 3 }], home);
    expect(made).toEqual([1, 2, 3].map((n) => join(home, "Downloads", "b", `f-${n}.tmp`)));
  });

  it("~ 확장", () => {
    expect(expandHome("~/a", home)).toBe(join(home, "a"));
  });
});

describe("결과 검증", () => {
  it("파일·휴지통·글로브·셸·답변 검증", async () => {
    writeFixtures([{ path: "~/keep.txt", content: "DESKTOP_AGENT_DEMO=1\n" }], home);
    mkdirSync(join(home, ".Trash"));
    writeFileSync(join(home, ".Trash", "desktop-agent-scenario-old.pdf"), "");
    const results = await runChecks(
      [
        { type: "missing", path: "~/gone.pdf" },
        { type: "exists", path: "~/keep.txt" },
        { type: "file_contains", path: "~/keep.txt", text: "DESKTOP_AGENT_DEMO" },
        { type: "glob_count", pattern: "~/*.tmp", count: 0 },
        { type: "in_trash", name_prefix: "desktop-agent-scenario-old", min_count: 1 },
        { type: "shell", command: "printf 1", stdout: "1" },
        { type: "reply_mentions", all_of: [["새", "다시"], ["터미널"]] },
      ],
      { home, reply: "새 터미널을 열면 적용됩니다." },
    );
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("검증 중 오류(휴지통 없음 등)는 실패로 기록하고 나머지는 계속한다", async () => {
    const results = await runChecks(
      [
        { type: "in_trash", name_prefix: "abc", min_count: 1 },
        { type: "missing", path: "~/nothing" },
      ],
      { home, reply: "" },
    );
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0]?.detail).toContain("오류");
  });
});

const decision = (ruleIds: string[]): PolicyDecision => ({
  grade: 2,
  action: "ask",
  ruleIds,
  reasons: [],
  flags: [],
});

function shellEvent(
  command: string,
  outcome: GateEvent["outcome"],
  executed: string | null,
): GateEvent {
  return {
    toolUseId: command,
    call: { toolName: "mcp__agent__shell", input: { command } },
    decision: decision(["x"]),
    outcome,
    decidedBy: "policy",
    executedInput: executed === null ? null : { command: executed },
  };
}

describe("기대 동작 확인", () => {
  const scenario = parseScenario(
    [
      "id: t",
      "title: t",
      "request: r",
      "expect:",
      "  min_approvals: 1",
      "  max_approvals: 1",
      "  approved_rules: [cmd.rm.bulk]",
      "  outcomes_include: [approved]",
      "  executed_include: ['trash']",
      "  executed_exclude: ['(^|[;&|]\\s*)rm\\s']",
    ].join("\n"),
    "t.yaml",
  );

  const record = (events: GateEvent[], approvals = 1): RunRecord => ({
    events,
    approvals: Array.from({ length: approvals }, () => ({
      toolName: "mcp__agent__shell",
      ruleIds: ["cmd.rm.bulk"],
      grade: 2,
      answer: "approved" as const,
    })),
    agentOk: true,
    ungated: 0,
    unfiltered: 0,
  });

  it("치환된 명령이 실행되고 승인 1회면 통과", () => {
    const r = record([shellEvent("rm ~/b/*.tmp", "approved", "/usr/bin/trash ~/b/*.tmp")]);
    expect(evaluateExpect(scenario, r).filter((c) => !c.ok)).toEqual([]);
    expect(executedCommands(r.events)).toEqual(["/usr/bin/trash ~/b/*.tmp"]);
  });

  it("원래 rm이 실행되면(영구 삭제) 실패", () => {
    const r = record([shellEvent("rm ~/b/*.tmp", "approved", "rm ~/b/*.tmp")]);
    const failed = evaluateExpect(scenario, r)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed.some((n) => n.startsWith("실행되면 안 됨"))).toBe(true);
  });

  it("승인 횟수가 범위를 벗어나거나 미경유 호출이 있으면 실패", () => {
    const r = { ...record([], 2), ungated: 1 };
    const failed = evaluateExpect(scenario, r)
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["승인 요청 1~1회", "decide() 미경유 0건"]));
  });
});

describe("승인자와 지표", () => {
  it("허용 규칙이 있으면 승인, 없으면 거절하고 모두 기록한다", async () => {
    const { approver, records } = createScenarioApprover(["path.shell_config"]);
    const call = { toolName: "mcp__agent__shell", input: {} };
    expect(await approver.ask(call, decision(["path.shell_config"]))).toBe("approved");
    expect(await approver.ask(call, decision(["cmd.launchctl"]))).toBe("rejected");
    expect(records.map((r) => r.answer)).toEqual(["approved", "rejected"]);
  });

  it("성공률·요청당 승인 평균·비용 합계", () => {
    const base = { title: "", checks: [], executed: [], durationMs: 0 };
    const results: ScenarioResult[] = [
      { ...base, id: "a", passed: true, approvals: 0, costUsd: 0.1, turns: 2 },
      { ...base, id: "b", passed: false, approvals: 2, costUsd: 0.3, turns: 4 },
    ];
    expect(summarize(results)).toMatchObject({
      passed: 1,
      successRate: 0.5,
      avgApprovals: 1,
      avgTurns: 3,
    });
    expect(summarize(results).totalCostUsd).toBeCloseTo(0.4);
  });
});

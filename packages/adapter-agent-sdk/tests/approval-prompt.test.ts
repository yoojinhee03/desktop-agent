import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { PolicyDecision, ToolCall } from "@desktop-agent/policy-core";
import { describe, expect, it } from "vitest";
import {
  type ApprovalReply,
  type ApprovalView,
  agentToolName,
  buildApprovalView,
  createPolicyGate,
  createScriptedApprover,
  createTerminalApprover,
  type GateEvent,
  printable,
  unifiedDiff,
} from "../src/index.ts";
import { baseContext, callHook, preToolUse } from "./helpers.ts";

const ask: PolicyDecision = { grade: 2, action: "ask", ruleIds: ["t"], reasons: ["r"], flags: [] };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "approval-view-"));
}

describe("unifiedDiff", () => {
  it("바뀐 줄과 앞뒤 문맥을 보여준다", () => {
    const diff = unifiedDiff("a\nb\nc\nd\n", "a\nb\nC\nd\n", { context: 1 });
    expect(diff).toBe("@@ -2,3 +2,3 @@\n b\n-c\n+C\n d");
  });

  it("바뀐 것이 없으면 빈 문자열", () => {
    expect(unifiedDiff("same\n", "same\n")).toBe("");
  });

  it("새 파일은 모두 추가로 보인다", () => {
    expect(unifiedDiff("", "x\ny")).toBe("@@ -0,0 +1,2 @@\n+x\n+y");
  });

  it("멀리 떨어진 변경은 구간을 나눈다", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const next = old.map((l, i) => (i === 1 || i === 18 ? `${l}!` : l));
    const diff = unifiedDiff(old.join("\n"), next.join("\n"), { context: 1 });
    expect(diff.match(/^@@/gm)).toHaveLength(2);
  });

  it("너무 길면 잘라내고 남은 줄 수를 알린다", () => {
    const next = Array.from({ length: 200 }, (_, i) => `n${i}`).join("\n");
    const diff = unifiedDiff("", next, { maxLines: 10 });
    expect(diff.split("\n")).toHaveLength(11);
    expect(diff).toContain("줄 더 있음");
  });

  it("큰 파일 전체가 바뀌어도 멈추지 않는다 (LCS 생략)", () => {
    const a = Array.from({ length: 1000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1000 }, (_, i) => `b${i}`).join("\n");
    expect(unifiedDiff(a, b, { maxLines: 5 })).toContain("-a0");
  });
});

describe("printable", () => {
  it("터미널 제어 문자와 방향 제어 문자를 보이는 형태로 바꾼다", () => {
    expect(printable("rm -rf ~\r ls")).toBe("rm -rf ~\\x0d ls");
    expect(printable("\u001b[2K")).toBe("\\x1b[2K");
    expect(printable("a‮b")).toBe("a\\u{202e}b");
  });

  it("한글·탭은 그대로 둔다", () => {
    expect(printable("문서\t정리")).toBe("문서\t정리");
  });
});

describe("buildApprovalView", () => {
  it("write_file: 새 파일이면 추가 내용을 보여준다", async () => {
    const dir = tempDir();
    const call = {
      toolName: agentToolName("write_file"),
      input: { path: "new.txt", content: "hi" },
    };
    const view = await buildApprovalView(call, ask, { cwd: dir, home: dir });
    expect(view.diff).toContain("+hi");
  });

  it("edit_file: 실제 파일과 비교한 diff", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    const input = { path: join(dir, "a.txt"), old_text: "two", new_text: "TWO" };
    const view = await buildApprovalView({ toolName: agentToolName("edit_file"), input }, ask, {
      cwd: "/",
      home: dir,
    });
    expect(view.diff).toContain("-two\n+TWO");
  });

  it("edit_file: 바꿀 문자열이 여러 곳이면 diff 대신 이유", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "x x");
    const input = { path: "a.txt", old_text: "x", new_text: "y" };
    const call = { toolName: agentToolName("edit_file"), input };
    const view = await buildApprovalView(call, ask, { cwd: dir, home: dir });
    expect(view).toEqual({ note: "바꿀 문자열이 2곳에서 발견됨 (도구가 실행을 거부함)" });
  });

  it("정책 엔진이 준 diff가 있으면 그것을 쓴다", async () => {
    const decision = { ...ask, preview: { paths: [], diff: "engine diff" } };
    const view = await buildApprovalView({ toolName: "Bash", input: {} }, decision, {
      cwd: "/",
      home: "/",
    });
    expect(view).toEqual({ diff: "engine diff" });
  });

  it("파일 도구가 아니면 비어 있다", async () => {
    const call = { toolName: agentToolName("shell"), input: { command: "ls" } };
    expect(await buildApprovalView(call, ask, { cwd: "/", home: "/" })).toEqual({});
  });
});

/** 터미널 승인자를 띄우고, 질문이 나올 때마다 답을 하나씩 넣는다 */
async function terminal(call: ToolCall, answers: string[], view?: ApprovalView) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  let asked = 0;
  output.on("data", (c: Buffer) => {
    shown += c.toString();
    const questions = shown.split("? (").length - 1 + (shown.split("바꿀까요?").length - 1);
    while (asked < questions && asked < answers.length) input.write(`${answers[asked++]}\n`);
  });
  const reply = await createTerminalApprover(input, output).ask(call, ask, view);
  return { reply, shown };
}

const rmCall: ToolCall = { toolName: "Bash", input: { command: "rm a.txt" } };

describe("터미널 승인: 수정 요청과 diff 표시", () => {
  it("r을 고르고 이유를 쓰면 수정 요청이 된다", async () => {
    const { reply } = await terminal(rmCall, ["r", "보관 폴더로 옮겨줘"]);
    expect(reply).toEqual({ answer: "revision_requested", feedback: "보관 폴더로 옮겨줘" });
  });

  it("r 뒤에 아무것도 안 쓰면 거절", async () => {
    const { reply } = await terminal(rmCall, ["r", "  "]);
    expect(reply).toBe("rejected");
  });

  it("선택지에 수정 요청이 보이고 diff가 함께 나온다", async () => {
    const { shown } = await terminal(rmCall, ["n"], { diff: "-old\n+new" });
    expect(shown).toContain("r: 수정 요청");
    expect(shown).toContain("바뀌는 내용:\n    -old\n    +new");
  });

  it("명령 속 제어 문자는 승인 창에 그대로 찍지 않는다", async () => {
    const call = { toolName: "Bash", input: { command: "rm -rf ~\u001b[2K\rls" } };
    const { shown } = await terminal(call, ["n"]);
    expect(shown).not.toContain("\u001b[2K");
    expect(shown).toContain("\\x1b[2K\\x0dls");
  });
});

function gateWith(reply: ApprovalReply, seen: (ApprovalView | undefined)[] = [], cwd = "/tmp") {
  const events: GateEvent[] = [];
  const gate = createPolicyGate({
    decide: () => ask,
    context: baseContext(cwd),
    approver: createScriptedApprover("t", (_c, _d, view) => {
      seen.push(view);
      return reply;
    }),
    onEvent: (e) => {
      events.push(e);
    },
  });
  return { gate, events };
}

describe("게이트: 수정 요청", () => {
  it("실행하지 않고, 사용자의 말을 에이전트에게 사유로 전한다", async () => {
    const { gate, events } = gateWith({
      answer: "revision_requested",
      feedback: "휴지통 말고 보관",
    });
    const out = await callHook(gate, preToolUse("Bash", { command: "rm a" }));
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain('수정을 요청함: "휴지통 말고 보관"');
    expect(events[0]).toMatchObject({
      outcome: "revision_requested",
      executedInput: null,
      feedback: "휴지통 말고 보관",
      decidedBy: "script:t",
    });
  });

  it("파일 도구 승인에는 diff를 넘기고, 원본 파일은 건드리지 않는다", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "n.txt"), "before\n");
    const seen: (ApprovalView | undefined)[] = [];
    const { gate } = gateWith("rejected", seen, dir);
    const input = { path: "n.txt", content: "after\n" };
    await callHook(gate, preToolUse(agentToolName("write_file"), input));
    expect(seen[0]?.diff).toContain("-before\n+after");
    expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("before\n");
  });
});

// 자체 MCP 도구: 승인 장부 없이는 실행 안 함, bash --noprofile --norc, 결과는 항상 프라이버시 필터를 거친다.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyDecision, PolicyFlag } from "@desktop-agent/policy-core";
import { RuleBasedFilter, WITHHELD_NOTICE } from "@desktop-agent/privacy-filter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalLedger,
  agentSchemaKeys,
  agentToolName,
  createAgentTools,
  type FilterEvent,
} from "../src/index.ts";

let dir: string;
let ledger: ApprovalLedger;
let filterEvents: FilterEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-tools-"));
  ledger = new ApprovalLedger(agentSchemaKeys);
  filterEvents = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function decision(flags: PolicyFlag[] = []): PolicyDecision {
  return { grade: 0, action: "allow", ruleIds: ["t"], reasons: [], flags };
}

function tools() {
  const list = createAgentTools({
    cwd: dir,
    home: dir,
    ledger,
    filter: new RuleBasedFilter(),
    onFilter: (e) => {
      filterEvents.push(e);
    },
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

/** 게이트가 승인한 것처럼 장부에 올리고 도구를 부른다 */
async function call(name: string, args: Record<string, unknown>, flags: PolicyFlag[] = []) {
  ledger.grant({
    toolUseId: `tu_${name}`,
    toolName: agentToolName(name as never),
    input: args,
    decision: decision(flags),
  });
  return invoke(name, args);
}

async function invoke(name: string, args: Record<string, unknown>) {
  const t = tools()[name];
  if (!t) throw new Error(`도구 없음: ${name}`);
  const result = await t.handler(args as never, {});
  const first = result.content[0];
  return { text: first?.type === "text" ? first.text : "", isError: result.isError === true };
}

describe("승인 장부", () => {
  it("승인 기록이 없으면 실행하지 않는다", async () => {
    const marker = join(dir, "marker");
    const out = await invoke("shell", { command: `touch ${marker}` });
    expect(out.isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(filterEvents[0]?.refused).toBeTruthy();
  });

  it("한 번의 승인은 한 번만 쓰인다", async () => {
    await call("shell", { command: "true" });
    const again = await invoke("shell", { command: "true" });
    expect(again.isError).toBe(true);
  });

  it("승인한 입력과 다른 입력(치환 전 원래 명령 등)은 실행하지 않는다", async () => {
    ledger.grant({
      toolUseId: "tu",
      toolName: agentToolName("shell"),
      input: { command: "/usr/bin/trash ./a.pdf" },
      decision: decision(),
    });
    expect(ledger.take(agentToolName("shell"), { command: "rm ./a.pdf" })).toBeNull();
    expect(
      ledger.take(agentToolName("shell"), { command: "/usr/bin/trash ./a.pdf" }),
    ).not.toBeNull();
  });

  it("자체 도구가 아니면 장부에 올리지 않는다", () => {
    ledger.grant({
      toolUseId: "tu",
      toolName: "WebFetch",
      input: { url: "x" },
      decision: decision(),
    });
    expect(ledger.take("WebFetch", { url: "x" })).toBeNull();
  });
});

describe("shell 도구", () => {
  it("bash로 실행하고 작업 폴더에서 돈다", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 셸에 넘기는 bash 변수 확장이다
    const out = await call("shell", { command: 'echo "bash=${BASH_VERSION:+yes}"; pwd' });
    expect(out.text).toContain("bash=yes");
    expect(out.text).toContain("exit_code: 0");
  });

  it("BASH_ENV로 지정한 파일을 읽지 않는다", async () => {
    const rc = join(dir, "evil-rc");
    writeFileSync(rc, "echo INJECTED\n");
    const prev = process.env.BASH_ENV;
    process.env.BASH_ENV = rc;
    try {
      const out = await call("shell", { command: "echo clean" });
      expect(out.text).not.toContain("INJECTED");
    } finally {
      if (prev === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = prev;
    }
  });

  it("출력의 시크릿을 가리고, 무엇을 가렸는지 기록한다(원문 없이)", async () => {
    const out = await call("shell", { command: "echo DB_PASSWORD=hunter2-Prod!" });
    expect(out.text).not.toContain("hunter2-Prod!");
    expect(filterEvents[0]).toMatchObject({
      toolUseId: "tu_shell",
      maskings: [{ kind: "generic_secret", count: 1 }],
      withheld: null,
    });
    expect(JSON.stringify(filterEvents)).not.toContain("hunter2");
  });
});

describe("파일 도구", () => {
  it("local_only 판정이면 파일 내용을 보내지 않는다", async () => {
    mkdirSync(join(dir, ".aws"));
    writeFileSync(join(dir, ".aws", "credentials"), "[default]\nregion = ap-northeast-2\n");
    const out = await call("read_file", { path: "~/.aws/credentials" }, ["local_only"]);
    expect(out.text).toBe(WITHHELD_NOTICE);
    expect(out.text).not.toContain("ap-northeast-2");
  });

  it("쓰기·수정·찾기·읽기", async () => {
    await call("write_file", { path: "notes/a.txt", content: "hello world\n" });
    await call("edit_file", { path: "notes/a.txt", old_text: "world", new_text: "agent" });
    const listed = await call("list_files", { pattern: "**/*.txt" });
    expect(listed.text).toContain(join(dir, "notes", "a.txt"));
    const read = await call("read_file", { path: "notes/a.txt" });
    expect(read.text).toBe("hello agent\n");
  });

  it("오류 메시지도 필터를 거쳐 오류로 돌려준다", async () => {
    const out = await call("read_file", { path: "missing.txt" });
    expect(out.isError).toBe(true);
    expect(filterEvents).toHaveLength(1);
  });
});

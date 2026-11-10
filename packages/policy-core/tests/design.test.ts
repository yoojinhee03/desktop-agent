// "설계: 정책 엔진" 테스트 케이스 14개 (tests/cases/design.yaml + 세션 허용 케이스)
import { beforeAll, describe, expect, it } from "vitest";
import { decide, ready } from "../src/decide.ts";
import { allowForSession } from "../src/session.ts";
import { checkCase, contextFor, judgeCase, loadCases } from "./helpers/cases.ts";

beforeAll(async () => {
  await ready();
});

describe("설계 문서 테스트 케이스", () => {
  const cases = loadCases("design.yaml");

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    checkCase(c, judgeCase(c));
  });

  it("design.06 brew install jq: 2등급, 세션 허용 후 두 번째는 자동", () => {
    const c = {
      ...cases[0],
      id: "design.06",
      command: "brew install jq",
    } as (typeof cases)[number];
    const call = { toolName: "Bash", input: { command: "brew install jq" } };
    const first = decide(call, contextFor(c));
    expect(first.grade).toBe(2);
    expect(first.action).toBe("ask");
    expect(first.allowKeys).toEqual(["cmd.brew.install"]);
    const ctx = contextFor(c);
    const second = decide(call, { ...ctx, session: allowForSession(ctx.session, first) });
    expect(second.grade).toBe(2);
    expect(second.action).toBe("allow");
  });

  it("design.13 차단 판정은 이유를 돌려준다", () => {
    const c = cases.find((x) => x.id === "design.13");
    if (!c) throw new Error("design.13 없음");
    const d = judgeCase(c);
    expect(d.reasons.join(" ")).toContain("SIP");
  });
});

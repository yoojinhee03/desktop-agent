import { describe, expect, it } from "vitest";
import { maskDeep, maskSecrets, maskTag, RuleBasedFilter, WITHHELD_NOTICE } from "../src/index.ts";
import { NEGATIVE, POSITIVE } from "./secret-cases.ts";

describe("시크릿 마스킹 테스트셋: 반드시 가려야 하는 것", () => {
  it.each(POSITIVE)("$name", ({ kind, secret, text }) => {
    const out = maskSecrets(text);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(maskTag(kind));
    expect(out.maskings.find((m) => m.kind === kind)?.count).toBeGreaterThan(0);
  });

  it("재현율: 양성 예시 전부 탐지", () => {
    const missed = POSITIVE.filter((c) => maskSecrets(c.text).text.includes(c.secret));
    expect(missed.map((c) => c.name)).toEqual([]);
  });
});

describe("시크릿 마스킹 테스트셋: 가리면 안 되는 것", () => {
  it.each(NEGATIVE)("$name", ({ text }) => {
    const out = maskSecrets(text);
    expect(out.text).toBe(text);
    expect(out.maskings).toEqual([]);
  });
});

describe("마스킹 동작", () => {
  it("키 이름과 구분자는 남기고 값만 가린다", () => {
    expect(maskSecrets("DB_PASSWORD=hunter2-Prod!").text).toBe(
      `DB_PASSWORD=${maskTag("generic_secret")}`,
    );
  });

  it("한 출력에 여러 시크릿이 있으면 종류별 개수를 센다", () => {
    const text = POSITIVE.filter((c) => c.kind === "github_token")
      .map((c) => c.text)
      .join("\n");
    expect(maskSecrets(text).maskings).toEqual([{ kind: "github_token", count: 2 }]);
  });

  it("이미 가린 결과를 다시 넣어도 바뀌지 않는다 (멱등)", () => {
    const once = maskSecrets(POSITIVE.map((c) => c.text).join("\n")).text;
    expect(maskSecrets(once).text).toBe(once);
  });
});

describe("RuleBasedFilter", () => {
  const filter = new RuleBasedFilter();

  it("일반 출력은 마스킹만 하고 보낸다", async () => {
    const out = await filter.process({
      toolName: "shell",
      text: "DB_PASSWORD=hunter2-Prod!",
      flags: [],
    });
    expect(out.withheld).toBeNull();
    expect(out.text).not.toContain("hunter2-Prod!");
  });

  it("local_only 판정이면 원문을 전혀 보내지 않는다", async () => {
    const out = await filter.process({
      toolName: "read_file",
      text: "[default]\nregion = ap-northeast-2\n",
      flags: ["local_only"],
    });
    expect(out).toEqual({ text: WITHHELD_NOTICE, maskings: [], withheld: "local_only" });
  });
});

describe("maskDeep (감사 로그용 입력 마스킹)", () => {
  it("중첩 객체·배열의 문자열 값을 모두 가리고 나머지는 그대로 둔다", () => {
    const input = {
      command: "curl -H 'Authorization: Bearer abcdefgh12345678' https://api",
      env: ["DB_PASSWORD=hunter2-Prod!"],
      timeout_ms: 1000,
    };
    const out = maskDeep(input);
    expect(JSON.stringify(out)).not.toContain("abcdefgh12345678");
    expect(JSON.stringify(out)).not.toContain("hunter2-Prod!");
    expect(out.timeout_ms).toBe(1000);
    expect(input.env[0]).toBe("DB_PASSWORD=hunter2-Prod!"); // 원본은 바꾸지 않는다
  });
});

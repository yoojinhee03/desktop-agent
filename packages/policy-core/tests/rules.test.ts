// 규칙 파일 검증: 실제 macos.yaml이 스키마를 통과하고, 잘못된 파일은 거부되는지
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRules, RuleFileError } from "../src/rules/load.ts";

const yamlText = readFileSync(new URL("../rules/macos.yaml", import.meta.url), "utf8");

describe("rules/macos.yaml", () => {
  it("스키마를 통과한다", () => {
    const file = parseRules(yamlText);
    expect(file.commands.length).toBeGreaterThan(50);
    expect(file.path_classes.map((c) => c.id)).toContain("path.browser_secrets");
  });

  it("설계 문서의 차단 항목이 모두 들어 있다", () => {
    const ids = new Set(parseRules(yamlText).commands.map((r) => r.id));
    for (const id of [
      "block.disk_format",
      "block.diskutil",
      "block.dd_device",
      "block.csrutil",
      "block.spctl",
      "block.fdesetup",
      "block.firewall_off",
      "block.keychain_dump",
      "block.keychain_password",
      "block.history_clear",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("알 수 없는 키·잘못된 등급은 거부한다", () => {
    const bad = yamlText.replace(
      "grade: block\n    reason: 디스크 포맷",
      "grade: 9\n    reason: 디스크 포맷",
    );
    expect(() => parseRules(bad)).toThrow(RuleFileError);
    expect(() => parseRules(`${yamlText}\nextra: 1\n`)).toThrow(RuleFileError);
  });

  it("엔진 규칙이 빠지면 거부한다", () => {
    const bad = yamlText.replace(/^ {2}- \{ id: block\.fork_bomb.*$/m, "");
    expect(() => parseRules(bad)).toThrow(/block\.fork_bomb/);
  });
});

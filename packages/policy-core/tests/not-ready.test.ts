// ready() 전에 decide()를 부르면 조용히 넘기지 않고 오류를 던진다 (파일마다 모듈이 분리되어 초기화 전 상태)
import { describe, expect, it } from "vitest";
import { decide, PolicyNotReadyError } from "../src/index.ts";

describe("초기화 전 판정", () => {
  it("PolicyNotReadyError를 던진다", () => {
    expect(() => decide({ toolName: "Bash", input: { command: "ls" } })).toThrow(
      PolicyNotReadyError,
    );
  });
});

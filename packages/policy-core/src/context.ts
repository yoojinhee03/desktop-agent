// 실제 환경의 기본 판정 문맥. 테스트·어댑터는 DecideContext를 직접 넘겨 바꿀 수 있다.
import { homedir } from "node:os";
import { nodeFs } from "./fs/node-fs.ts";
import { emptySession } from "./session.ts";
import type { DecideContext } from "./types.ts";

export function defaultContext(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    home: homedir(),
    cwd: process.cwd(),
    fs: nodeFs,
    session: emptySession(),
    agentPaths: [],
    ...overrides,
  };
}

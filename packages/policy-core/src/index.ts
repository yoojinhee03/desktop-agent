// @desktop-agent/policy-core 공개 API
// 사용 순서: await ready() → decide(call, ctx) → (승인·실행 후) recordExecution(session, decision)

export { defaultContext } from "./context.ts";
export { decide, type ReadyOptions, ready } from "./decide.ts";
export { nodeFs } from "./fs/node-fs.ts";
export { PolicyNotReadyError } from "./parse/parser.ts";
export { parseRules, RuleFileError } from "./rules/load.ts";
export {
  allowForSession,
  emptySession,
  endUserRequest,
  markExternalContent,
  recordExecution,
} from "./session.ts";
export type * from "./types.ts";

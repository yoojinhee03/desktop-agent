import type { Handler } from "../../rules/schema.ts";
import { awkHandler, interpreterHandler } from "./code.ts";
import { dockerHandler, gitConfigHandler, schedulerHandler } from "./deferred.ts";
import { cdHandler, evalHandler, shellHandler, sourceHandler } from "./exec.ts";
import { ddHandler, findHandler, openHandler, rmHandler } from "./files.ts";
import { curlHandler, sshHandler, transferHandler, wgetHandler } from "./net.ts";
import type { HandlerFn } from "./types.ts";
import { wrapperHandler, xargsHandler } from "./wrap.ts";

/** 규칙 파일의 handler 이름 → 구현. 이름 목록은 rules/schema.ts의 HANDLERS와 같다 */
export const HANDLER_FNS: Record<Handler, HandlerFn> = {
  wrapper: wrapperHandler,
  shell: shellHandler,
  eval: evalHandler,
  source: sourceHandler,
  interpreter: interpreterHandler,
  awk: awkHandler,
  xargs: xargsHandler,
  find: findHandler,
  rm: rmHandler,
  dd: ddHandler,
  curl: curlHandler,
  wget: wgetHandler,
  transfer: transferHandler,
  open: openHandler,
  cd: cdHandler,
  ssh: sshHandler,
  scheduler: schedulerHandler,
  docker: dockerHandler,
  git_config: gitConfigHandler,
};

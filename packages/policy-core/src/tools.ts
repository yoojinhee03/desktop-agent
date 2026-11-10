// 도구 이름별 판정 경로. shell은 명령 분해, 파일 도구는 경로 규칙, 웹은 0등급 + 외부 콘텐츠 표시.
// MCP 도구 이름(mcp__서버__도구)은 마지막 부분으로 판단한다.

import { judgePath } from "./judge/path-judge.ts";
import { judgeScript } from "./judge/script.ts";
import { addEngine, emptyInfo, type JudgeCtx } from "./judge/state.ts";
import { normalizePath } from "./paths.ts";
import type { ToolCall } from "./types.ts";

const SHELL = /^(bash|shell|run_shell|run_command|execute_command|terminal|exec)$/i;
const READ = /^(read|read_file|view|notebookread|open_file)$/i;
const SEARCH = /^(grep|search|search_files|ripgrep)$/i;
const LIST = /^(glob|ls|list_dir|list_files|find_files)$/i;
const WRITE =
  /^(write|edit|multiedit|notebookedit|write_file|edit_file|create_file|str_replace|apply_patch)$/i;
const WEB = /^(webfetch|websearch|web_fetch|web_search|fetch|browse)$/i;

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath", "target_file", "directory"];

/** 판정하고, 치환에 쓸 원문(shell 명령)을 돌려준다 */
export function judgeTool(call: ToolCall, jc: JudgeCtx): string | null {
  const name = baseName(call.toolName);
  if (SHELL.test(name)) {
    const command = stringInput(call, ["command", "cmd"]);
    if (command === null) addEngine(jc, "parse.unparseable", "명령 문자열 없음");
    else judgeScript(command, jc);
    return command;
  }
  if (READ.test(name)) judgeToolPath(call, jc, "read", false);
  else if (SEARCH.test(name)) judgeToolPath(call, jc, "read", true);
  else if (LIST.test(name)) judgeToolPath(call, jc, "meta", false);
  else if (WRITE.test(name)) judgeToolPath(call, jc, "write", false);
  else if (WEB.test(name)) addEngine(jc, "tool.web");
  else addEngine(jc, "tool.unknown", call.toolName, call.toolName);
  return null;
}

function baseName(toolName: string): string {
  const i = toolName.lastIndexOf("__");
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

function stringInput(call: ToolCall, keys: string[]): string | null {
  for (const k of keys) {
    const v = call.input[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function judgeToolPath(
  call: ToolCall,
  jc: JudgeCtx,
  op: "read" | "write" | "meta",
  recursive: boolean,
): void {
  const raw = stringInput(call, PATH_KEYS) ?? (op === "write" ? null : ".");
  const abs = raw === null ? null : normalizePath(raw, jc.base);
  if (abs === null) {
    addEngine(jc, "path.dynamic", raw ?? "경로 없음");
    return;
  }
  addEngine(jc, op === "write" ? "tool.file_write" : "tool.file_read", raw ?? undefined);
  judgePath(jc, abs, op, recursive, emptyInfo());
}

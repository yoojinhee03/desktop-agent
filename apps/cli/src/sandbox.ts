import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApprovalAnswer, agentToolName, describeCall } from "@desktop-agent/adapter-agent-sdk";
import type { ToolCall } from "@desktop-agent/policy-core";

const PDF_STUB = "%PDF-1.4\n%sandbox fixture\n%%EOF\n";
const FIXTURES: Record<string, string> = {
  "Downloads/견적서_2026.pdf": PDF_STUB,
  "Downloads/report.pdf": PDF_STUB,
  "Downloads/notes.txt": "샘플 텍스트\n",
  // 마스킹 확인용 가짜 설정 파일 (실제 비밀번호 아님)
  "Downloads/config.txt": "DB_HOST=localhost\nDB_PASSWORD=sandbox-Pa55word!\n",
  "Downloads/archive/invoice-old.pdf": PDF_STUB,
};

export interface Sandbox {
  root: string;
  aliases: string[]; // /var/... 와 /private/var/... 처럼 같은 폴더의 다른 표기
}

/** 개발용 에이전트 실행 폴더($TMPDIR/desktop-agent-sandbox)와 가짜 다운로드 폴더를 만든다. */
export async function prepareSandbox(): Promise<Sandbox> {
  const root = join(tmpdir(), "desktop-agent-sandbox");
  for (const [rel, body] of Object.entries(FIXTURES)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const real = await realpath(root);
  return { root: real, aliases: [...new Set([root, real])] };
}

export function sandboxPromptNote(sandbox: Sandbox): string {
  return [
    `이번 실행은 개발용 샌드박스다. 사용자의 '다운로드 폴더'는 ${sandbox.root}/Downloads 를 뜻한다.`,
    "샌드박스 밖의 경로는 읽거나 쓰지 않는다.",
  ].join("\n");
}

const READ_ONLY_BASH = /^(find|ls|mdfind|file|stat)\s/;
const SHELL_META = /[;&|<>`$]|-delete|-exec/;
const PATH_TOKEN = /(?:^|\s|['"=])((?:\/|~)[^\s'"]*)/g;

function insideSandbox(path: string, sandbox: Sandbox): boolean {
  return sandbox.aliases.some((root) => path === root || path.startsWith(`${root}/`));
}

function bashIsSafe(command: string, sandbox: Sandbox): boolean {
  if (!READ_ONLY_BASH.test(command) || SHELL_META.test(command)) return false;
  const paths = [...command.matchAll(PATH_TOKEN)].map((m) => m[1] ?? "");
  return paths.every((p) => insideSandbox(p, sandbox));
}

/**
 * 자동 확인 실행용 승인 판단: 샌드박스 안의 읽기 전용 호출만 승인하고 나머지는 거절한다.
 * 사람이 직접 쓸 때는 터미널 y/n 승인을 쓴다.
 */
export const SANDBOX_JUDGE_ID = "sandbox-readonly";

const SHELL_TOOLS = ["Bash", agentToolName("shell")];
const READ_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  agentToolName("read_file"),
  agentToolName("list_files"),
];

export function sandboxReadOnlyJudge(sandbox: Sandbox) {
  return (call: ToolCall): ApprovalAnswer => {
    if (SHELL_TOOLS.includes(call.toolName)) {
      return bashIsSafe(describeCall(call), sandbox) ? "approved" : "rejected";
    }
    if (!READ_TOOLS.includes(call.toolName)) return "rejected";
    const path = call.input.file_path ?? call.input.path;
    if (path === undefined) return "approved"; // cwd(샌드박스) 기준 검색
    return typeof path === "string" && insideSandbox(path, sandbox) ? "approved" : "rejected";
  };
}

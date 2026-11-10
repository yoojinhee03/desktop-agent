import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { MaskingRecord, PrivacyFilter } from "@desktop-agent/privacy-filter";
import { z } from "zod";
import { editTextFile, type FileContext, listFiles, readTextFile, writeTextFile } from "./files.ts";
import type { ApprovalLedger } from "./ledger.ts";
import { formatShellResult, runShell } from "./shell.ts";

/** SDK가 CallToolResult를 export하지 않아 도구 핸들러 반환형에서 꺼낸다 */
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

export const AGENT_SERVER = "agent";

/** 자체 MCP 도구의 입력 스키마. 장부 비교도 이 키만 쓴다 */
const SCHEMAS = {
  shell: {
    command: z.string().describe("bash 명령 (/bin/bash --noprofile --norc -c 로 실행)"),
    timeout_ms: z.number().int().positive().max(600_000).optional().describe("기본 120000"),
  },
  read_file: {
    path: z.string().describe("파일 경로 (절대 경로, ~, 또는 작업 폴더 기준 상대 경로)"),
    offset: z.number().int().min(0).optional().describe("시작 행 (0부터)"),
    limit: z.number().int().positive().max(5000).optional().describe("읽을 행 수, 기본 2000"),
  },
  write_file: { path: z.string(), content: z.string() },
  edit_file: {
    path: z.string(),
    old_text: z.string().describe("정확히 한 곳에만 있는 바꿀 문자열"),
    new_text: z.string(),
  },
  list_files: {
    pattern: z.string().describe("글로브 패턴, 예: **/*.pdf"),
    path: z.string().optional().describe("찾기 시작할 폴더, 기본은 작업 폴더"),
  },
} as const;

type ToolName = keyof typeof SCHEMAS;

export function agentToolName(name: ToolName): string {
  return `mcp__${AGENT_SERVER}__${name}`;
}

/** 승인 장부용: 자체 도구면 스키마 키 목록, 아니면 null */
export function agentSchemaKeys(toolName: string): readonly string[] | null {
  const prefix = `mcp__${AGENT_SERVER}__`;
  if (!toolName.startsWith(prefix)) return null;
  const short = toolName.slice(prefix.length);
  return short in SCHEMAS ? Object.keys(SCHEMAS[short as ToolName]) : null;
}

/** 필터 처리 기록 (감사 로그용, 원문 없음) */
export interface FilterEvent {
  toolUseId: string | null;
  toolName: string;
  maskings: MaskingRecord[];
  withheld: string | null;
  /** 승인 장부에 없어 실행하지 않았으면 그 이유 */
  refused?: string;
}

export interface AgentToolOptions extends FileContext {
  ledger: ApprovalLedger;
  filter: PrivacyFilter;
  onFilter?: (event: FilterEvent) => void | Promise<void>;
  maxOutputBytes?: number;
}

const NOT_APPROVED = "정책 엔진의 승인 기록이 없어 실행하지 않았습니다.";

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function runSafely(run: () => Promise<string>): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: await run(), isError: false };
  } catch (err) {
    return { text: `오류: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function refuse(opts: AgentToolOptions, toolName: string): Promise<CallToolResult> {
  const event = { toolUseId: null, toolName, maskings: [], withheld: null, refused: NOT_APPROVED };
  await opts.onFilter?.(event);
  return textResult(NOT_APPROVED, true);
}

/** 모든 자체 도구의 공통 흐름: 장부 확인 → 실행 → 프라이버시 필터 → 기록 → 필터된 결과만 반환 */
async function guarded(
  opts: AgentToolOptions,
  name: ToolName,
  args: Record<string, unknown>,
  run: () => Promise<string>,
): Promise<CallToolResult> {
  const toolName = agentToolName(name);
  const grant = opts.ledger.take(toolName, args);
  if (!grant) return refuse(opts, toolName);
  const { text, isError } = await runSafely(run);
  const filtered = await opts.filter.process({ toolName, text, flags: grant.decision.flags });
  const { maskings, withheld } = filtered;
  await opts.onFilter?.({ toolUseId: grant.toolUseId, toolName, maskings, withheld });
  return textResult(filtered.text, isError);
}

function shellTool(opts: AgentToolOptions) {
  const maxBytes = opts.maxOutputBytes ?? 100_000;
  return tool(
    "shell",
    "bash 명령을 실행한다. 결과는 프라이버시 필터를 거친다.",
    SCHEMAS.shell,
    (a) =>
      guarded(opts, "shell", a, async () => {
        const r = await runShell(a.command, {
          cwd: opts.cwd,
          timeoutMs: a.timeout_ms ?? 120_000,
          maxBytes,
        });
        return formatShellResult(r);
      }),
  );
}

function fileTools(opts: AgentToolOptions) {
  return [
    tool("read_file", "텍스트 파일을 읽는다.", SCHEMAS.read_file, (a) =>
      guarded(opts, "read_file", a, () => readTextFile(a.path, opts, a.offset, a.limit)),
    ),
    tool("write_file", "파일을 새로 쓰거나 덮어쓴다.", SCHEMAS.write_file, (a) =>
      guarded(opts, "write_file", a, () => writeTextFile(a.path, a.content, opts)),
    ),
    tool("edit_file", "파일에서 한 곳의 문자열을 바꾼다.", SCHEMAS.edit_file, (a) =>
      guarded(opts, "edit_file", a, () => editTextFile(a.path, a.old_text, a.new_text, opts)),
    ),
    tool("list_files", "글로브 패턴으로 파일 경로를 찾는다.", SCHEMAS.list_files, (a) =>
      guarded(opts, "list_files", a, () => listFiles(a.pattern, opts, a.path)),
    ),
  ];
}

/** 도구 정의 목록 (서버 없이 핸들러를 직접 시험할 때도 쓴다) */
export function createAgentTools(opts: AgentToolOptions) {
  return [shellTool(opts), ...fileTools(opts)];
}

/**
 * 내장 Bash·Read·Write·Edit·Glob·Grep 대신 쓰는 자체 MCP 도구.
 * 출력은 PrivacyFilter.process()를 거치지 않고는 모델에 갈 수 없다 (결정 로그 "프라이버시 필터는 MCP 래핑 도구로 강제").
 */
export function createAgentToolServer(opts: AgentToolOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: AGENT_SERVER,
    version: "0.1.0",
    instructions:
      "파일·셸 작업은 이 서버의 도구로만 한다. 모든 호출은 정책 엔진 판정을 거치고, 결과는 시크릿이 가려진 채 전달된다.",
    tools: createAgentTools(opts),
    alwaysLoad: true,
  });
}

import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface FileContext {
  cwd: string;
  home: string;
}

/** 정책 엔진과 같은 규칙으로 경로를 푼다: ~ 확장, 상대 경로는 cwd 기준 */
export function resolvePath(p: string, ctx: FileContext): string {
  if (p === "~") return ctx.home;
  if (p.startsWith("~/")) return join(ctx.home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
}

const MAX_READ_BYTES = 256 * 1024;

export async function readTextFile(
  path: string,
  ctx: FileContext,
  offset = 0,
  limit = 2000,
): Promise<string> {
  const buf = await readFile(resolvePath(path, ctx));
  if (buf.subarray(0, 8000).includes(0)) return "(바이너리 파일이라 내용을 읽지 않음)";
  const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
  const lines = text.split("\n");
  const body = lines.slice(offset, offset + limit).join("\n");
  const cut = buf.length > MAX_READ_BYTES || lines.length > offset + limit;
  return cut ? `${body}\n(일부만 표시: ${offset + 1}행부터 최대 ${limit}행)` : body;
}

export async function writeTextFile(path: string, content: string, ctx: FileContext) {
  const abs = resolvePath(path, ctx);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return `${abs}에 ${Buffer.byteLength(content)}바이트를 썼습니다.`;
}

export async function editTextFile(
  path: string,
  oldText: string,
  newText: string,
  ctx: FileContext,
): Promise<string> {
  const abs = resolvePath(path, ctx);
  const text = await readFile(abs, "utf8");
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`바꿀 문자열이 ${count}곳에서 발견됨 (정확히 1곳이어야 함)`);
  }
  await writeFile(
    abs,
    text.replace(oldText, () => newText),
    "utf8",
  );
  return `${abs}을 수정했습니다.`;
}

const MAX_LIST = 1000;

export async function listFiles(pattern: string, ctx: FileContext, path?: string) {
  const base = path ? resolvePath(path, ctx) : ctx.cwd;
  const found: string[] = [];
  for await (const f of glob(pattern, { cwd: base })) {
    found.push(join(base, f));
    if (found.length >= MAX_LIST) break;
  }
  const note = found.length >= MAX_LIST ? `\n(처음 ${MAX_LIST}개만 표시)` : "";
  return found.length === 0 ? "(일치하는 파일 없음)" : `${found.sort().join("\n")}${note}`;
}

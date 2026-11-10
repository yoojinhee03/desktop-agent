// tree-sitter-bash 파서 초기화. 웹어셈블리 로드가 비동기라 ready()에서 한 번만 하고,
// 판정(decide)은 동기로 유지한다. ready() 전에 판정하려 하면 오류를 던진다.
import { Language, Parser, type Tree } from "web-tree-sitter";

export class PolicyNotReadyError extends Error {
  constructor() {
    super("policy-core가 아직 초기화되지 않았다. 판정 전에 await ready()를 호출해야 한다.");
    this.name = "PolicyNotReadyError";
  }
}

let parser: Parser | null = null;

/** bashWasm: tree-sitter-bash.wasm 경로 또는 내용. 생략하면 의존성에서 찾는다. */
export async function initParser(bashWasm?: string | Uint8Array): Promise<void> {
  if (parser) return;
  await Parser.init();
  const lang = await Language.load(bashWasm ?? (await defaultWasmPath()));
  const p = new Parser();
  p.setLanguage(lang);
  parser = p;
}

async function defaultWasmPath(): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  return fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
}

export function isParserReady(): boolean {
  return parser !== null;
}

/** 구문 트리를 만들어 콜백에 넘기고, 끝나면 웹어셈블리 메모리를 해제한다. */
export function withTree<T>(source: string, fn: (tree: Tree) => T): T {
  if (!parser) throw new PolicyNotReadyError();
  const tree = parser.parse(source);
  if (!tree) throw new Error("tree-sitter가 구문 트리를 만들지 못했다");
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}

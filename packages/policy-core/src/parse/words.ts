// 단어 노드를 정적 값으로 푼다. 실행해야만 알 수 있는 부분이 있으면 value = null.
import type { Node } from "web-tree-sitter";
import type { Env } from "./model.ts";

export interface WordResolver {
  env: Env;
  /** $( ) 결과를 정적으로 알 수 있으면 그 문자열 (echo … | base64 -d 등) */
  evalSubst(node: Node): string | null;
}

interface Part {
  value: string | null;
  glob: boolean;
  /** 따옴표 밖 변수 확장이라 단어 분리가 일어날 수 있는지 */
  split: boolean;
}

const GLOB_CHARS = /[*?[]/;

export function resolveParts(node: Node, r: WordResolver): Part {
  switch (node.type) {
    case "word":
    case "number":
      return unquotedWord(node.text);
    case "raw_string":
      return lit(node.text.slice(1, -1));
    case "ansi_c_string":
      return lit(decodeAnsiC(node.text.slice(2, -1)));
    case "string":
    case "translated_string":
      return quotedString(node, r);
    case "simple_expansion":
    case "expansion":
      return { value: expansionValue(node, r.env), glob: false, split: true };
    case "command_substitution":
      return { value: r.evalSubst(node), glob: false, split: true };
    case "concatenation":
      return concat(node.namedChildren.filter(isNode).map((c) => resolveParts(c, r)));
    default:
      return { value: null, glob: false, split: false };
  }
}

function isNode(n: Node | null): n is Node {
  return n !== null;
}

function lit(value: string): Part {
  return { value, glob: false, split: false };
}

function unquotedWord(text: string): Part {
  let out = "";
  let glob = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\" && i + 1 < text.length) {
      out += text[++i] ?? "";
      continue;
    }
    if (GLOB_CHARS.test(ch)) glob = true;
    out += ch;
  }
  return { value: out, glob, split: false };
}

function quotedString(node: Node, r: WordResolver): Part {
  const parts: Part[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === "string_content") parts.push(lit(unescapeDouble(c.text)));
    else parts.push({ ...resolveParts(c, r), glob: false, split: false });
  }
  return concat(parts);
}

function concat(parts: Part[]): Part {
  let value: string | null = "";
  for (const p of parts) value = value === null || p.value === null ? null : value + p.value;
  return { value, glob: parts.some((p) => p.glob), split: parts.some((p) => p.split) };
}

function unescapeDouble(text: string): string {
  return text.replace(/\\([$`"\\\n])/g, (_m, ch: string) => (ch === "\n" ? "" : ch));
}

/** $X, ${X} 만 푼다. ${X:-…}, 배열, 위치 인자 등은 알 수 없음으로 둔다. */
function expansionValue(node: Node, env: Env): string | null {
  const named = node.namedChildren.filter(isNode);
  const only = named.length === 1 ? named[0] : undefined;
  if (!only || (only.type !== "variable_name" && only.type !== "special_variable_name"))
    return null;
  const expected = node.type === "expansion" ? `\${${only.text}}` : `$${only.text}`;
  if (node.text !== expected) return null;
  return env.vars.get(only.text) ?? null;
}

const SIMPLE_ESC: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** $'…' 의 이스케이프를 푼다 (\xHH, \uHHHH, \0oo 8진수 포함) */
export function decodeAnsiC(body: string): string {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g,
    (_m, esc: string) => decodeEscape(esc),
  );
}

function decodeEscape(esc: string): string {
  const head = esc[0] ?? "";
  if (head === "x" || head === "u" || head === "U") {
    return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
  }
  if (/^[0-7]+$/.test(esc)) return String.fromCharCode(Number.parseInt(esc, 8));
  if (head === "c") return String.fromCharCode((esc.charCodeAt(1) || 64) & 31);
  return SIMPLE_ESC[esc] ?? `\\${esc}`;
}

export function hasGlob(text: string): boolean {
  return GLOB_CHARS.test(text);
}

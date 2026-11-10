// extract.ts 보조 함수: 별칭, 포크 밤 형태, 리다이렉션 연산자, 리터럴 단어
import type { Node } from "web-tree-sitter";
import type { Cmd, Env, Word } from "./model.ts";

/** 이름(){ … 이름 | 이름 … } 처럼 자기 자신을 파이프로 다시 부르는 함수 */
export function isForkBomb(node: Node): boolean {
  const name = node.childForFieldName("name")?.text;
  const body = node.childForFieldName("body");
  if (!name || !body) return false;
  return body.descendantsOfType("pipeline").some((p) => {
    const names = p?.descendantsOfType("command_name").map((n) => n?.text) ?? [];
    return names.filter((n) => n === name).length >= 2;
  });
}

export function applyAlias(argv: Word[], env: Env): Word[] {
  const head = argv[0];
  const expanded = head?.value ? env.aliases.get(head.value) : undefined;
  if (!head || expanded === undefined) return argv;
  const words = expanded.split(/\s+/).filter(Boolean);
  return [...words.map((v) => ({ ...head, value: v })), ...argv.slice(1)];
}

export function learnAlias(cmd: Cmd, env: Env): void {
  if (cmd.argv[0]?.value !== "alias") return;
  for (const w of cmd.argv.slice(1)) {
    const m = w.value?.match(/^([^=]+)=(.*)$/s);
    if (m?.[1] !== undefined && m[2] !== undefined) env.aliases.set(m[1], m[2]);
  }
}

export function literalWord(node: Node): Word {
  return {
    raw: node.text,
    value: node.text,
    glob: false,
    inner: [],
    procSubst: false,
    start: node.startIndex,
    end: node.endIndex,
  };
}

export function opToken(node: Node): string {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed) return c.type;
  }
  return ">";
}

// 셸 명령 문자열 → 판정 단위 명령 목록.
// 파이프, &&, ||, ;, $( ), 백틱, <( ), 리다이렉션, 히어독, 함수·제어문 본문까지 모두 단위 명령으로 펼친다.
// bash -c 문자열 재파싱은 판정 단계(judge/shell.ts)에서 깊이를 세며 한다.
import type { Node } from "web-tree-sitter";
import { applyAlias, isForkBomb, learnAlias, literalWord, opToken } from "./extract-util.ts";
import type { Cmd, Env, Redirect, Script, Word } from "./model.ts";
import { withTree } from "./parser.ts";
import { evalStdout } from "./static-eval.ts";
import { resolveParts, type WordResolver } from "./words.ts";

export function extractScript(source: string, env: Env): Script {
  return withTree(source, (tree) => {
    const x = new Extractor(env);
    x.visit(tree.rootNode);
    return { source, cmds: x.cmds, error: tree.rootNode.hasError, forkBomb: x.forkBomb };
  });
}

class Extractor implements WordResolver {
  readonly cmds: Cmd[] = [];
  forkBomb = false;
  private readonly memo = new Map<number, Cmd>();
  private readonly pushed = new Set<Cmd>();

  constructor(readonly env: Env) {}

  visit(node: Node): void {
    switch (node.type) {
      case "command":
        this.push(this.commandOf(node));
        break;
      case "declaration_command":
        this.push(this.declarationOf(node));
        break;
      case "variable_assignment":
        if (node.parent?.type !== "command" && node.parent?.type !== "declaration_command") {
          this.push(this.statementAssign(node));
        }
        break;
      case "redirected_statement":
        this.redirected(node);
        return;
      case "pipeline":
        this.pipeline(node, []);
        return;
      case "function_definition":
        if (isForkBomb(node)) this.forkBomb = true;
        break;
    }
    this.visitChildren(node);
  }

  private visitChildren(node: Node): void {
    for (const c of node.namedChildren) if (c) this.visit(c);
  }

  private push(cmd: Cmd): void {
    if (this.pushed.has(cmd)) return;
    this.pushed.add(cmd);
    this.cmds.push(cmd);
  }

  // ---------- 단위 명령 ----------

  commandOf(node: Node): Cmd {
    const cached = this.memo.get(node.id);
    if (cached) return cached;
    const cmd = this.emptyCmd(node, "simple");
    this.memo.set(node.id, cmd);
    for (let i = 0; i < node.childCount; i++) this.commandChild(node, i, cmd);
    this.attachParentRedirects(node, cmd);
    cmd.argv = applyAlias(cmd.argv, this.env);
    learnAlias(cmd, this.env);
    return cmd;
  }

  private commandChild(node: Node, i: number, cmd: Cmd): void {
    const c = node.child(i);
    if (!c?.isNamed) return;
    const field = node.fieldNameForChild(i);
    if (c.type === "variable_assignment") cmd.assigns.push(this.assignmentOf(c));
    else if (field === "name") cmd.argv.push(...this.words(c.namedChildren[0] ?? c));
    else if (field === "argument") cmd.argv.push(...this.words(c));
    else if (c.type.endsWith("_redirect")) cmd.redirects.push(this.redirectOf(c));
  }

  private emptyCmd(node: Node, kind: Cmd["kind"]): Cmd {
    return {
      kind,
      argv: [],
      assigns: [],
      redirects: [],
      pipeFrom: [],
      start: node.startIndex,
      end: node.endIndex,
    };
  }

  private attachParentRedirects(node: Node, cmd: Cmd): void {
    const parent = node.parent;
    if (parent?.type !== "redirected_statement") return;
    if (parent.childForFieldName("body")?.id !== node.id) return;
    cmd.end = parent.endIndex;
    for (const r of parent.namedChildren) {
      if (r && r.id !== node.id && r.type.endsWith("_redirect"))
        cmd.redirects.push(this.redirectOf(r));
    }
  }

  private declarationOf(node: Node): Cmd {
    const cmd = this.emptyCmd(node, "declaration");
    const head = node.child(0);
    if (head) cmd.argv.push(literalWord(head));
    for (const c of node.namedChildren) {
      if (c?.type === "variable_assignment") this.addAssignWord(cmd, c);
      else if (c) cmd.argv.push(...this.words(c));
    }
    return cmd;
  }

  /** 문장 단위 대입(X=1)은 "(assign)" 명령으로 다룬다. PATH 등 위험한 변수 변경을 규칙으로 판정하기 위함 */
  private statementAssign(node: Node): Cmd {
    const cmd = this.emptyCmd(node, "declaration");
    cmd.argv.push({ ...literalWord(node), value: "(assign)" });
    this.addAssignWord(cmd, node);
    return cmd;
  }

  private addAssignWord(cmd: Cmd, node: Node): void {
    const a = this.assign(node);
    cmd.assigns.push(a);
    // 값이 동적이어도 이름은 정해져 있으므로 "NAME=" 형태로 남긴다 (값 안의 $( )는 따로 판정된다)
    cmd.argv.push({ ...literalWord(node), value: `${a.name}=${a.value ?? ""}` });
  }

  private assign(node: Node): { name: string; value: string | null } {
    const a = this.assignmentOf(node);
    // 같은 줄의 "x=1 cmd" 형태는 명령에만 적용되지만, 근사치로 이후 명령에도 반영한다.
    if (a.value !== null) this.env.vars.set(a.name, a.value);
    else this.env.vars.delete(a.name);
    return a;
  }

  private assignmentOf(node: Node): { name: string; value: string | null } {
    const name = node.childForFieldName("name")?.text ?? "";
    const valueNode = node.childForFieldName("value");
    const value = valueNode ? resolveParts(valueNode, this).value : "";
    return { name, value: valueNode?.type === "array" ? null : value };
  }

  // ---------- 단어 ----------

  private words(node: Node): Word[] {
    if (node.type === "process_substitution") return [this.procSubstWord(node)];
    const part = resolveParts(node, this);
    const base = {
      raw: node.text,
      glob: part.glob,
      inner: this.innerCmds(node),
      procSubst: false,
      start: node.startIndex,
      end: node.endIndex,
    };
    const sep = this.splitter();
    if (part.split && part.value !== null && sep.test(part.value)) {
      return part.value
        .split(sep)
        .filter((v) => v.length > 0)
        .map((v) => ({ ...base, value: v }));
    }
    return [{ ...base, value: part.value }];
  }

  /** 단어 분리 기준: IFS가 정적으로 바뀌었으면 그 문자들, 아니면 공백 */
  private splitter(): RegExp {
    const ifs = this.env.vars.get("IFS");
    if (ifs === undefined || ifs === "") return /\s+/;
    const chars = [...ifs].map((c) => c.replace(/[\]\\^-]/g, "\\$&")).join("");
    return new RegExp(`[${chars}]+`);
  }

  private procSubstWord(node: Node): Word {
    const inner = this.innerCmds(node);
    this.visitChildren(node);
    return {
      raw: node.text,
      value: null,
      glob: false,
      inner,
      procSubst: true,
      start: node.startIndex,
      end: node.endIndex,
    };
  }

  private innerCmds(node: Node): Cmd[] {
    if (node.type === "word" || node.type === "raw_string" || node.type === "number") return [];
    return node.descendantsOfType("command").flatMap((n) => (n ? [this.commandOf(n)] : []));
  }

  evalSubst(node: Node): string | null {
    const stages = this.substStages(node);
    const last = stages.at(-1);
    const out = last ? evalStdout(last) : null;
    return out === null ? null : out.replace(/\n+$/, "");
  }

  /** $( ) 안의 마지막 파이프라인 단계들을 미리 뽑는다(메모되므로 본 순회에서 중복되지 않는다). */
  private substStages(node: Node): Cmd[] {
    const body = node.namedChildren.filter((c): c is Node => c !== null);
    if (body.length !== 1 || !body[0]) return [];
    const only = body[0];
    if (only.type === "command") return [this.commandOf(only)];
    if (only.type === "pipeline") return this.pipeline(only, []);
    return [];
  }

  // ---------- 리다이렉션 ----------

  private redirectOf(node: Node): Redirect {
    if (node.type === "heredoc_redirect") return this.heredocOf(node);
    if (node.type === "herestring_redirect") {
      const w = node.namedChildren.at(-1);
      return { op: "<<<", target: null, body: w ? resolveParts(w, this).value : null };
    }
    const op = opToken(node);
    const dest = node.childForFieldName("destination");
    const isDup = op.endsWith("&") && dest?.type === "number";
    const target = dest && !isDup ? (this.words(dest)[0] ?? null) : null;
    return { op, target, body: null };
  }

  private heredocOf(node: Node): Redirect {
    const bodyNode = node.namedChildren.find((c) => c?.type === "heredoc_body");
    return { op: "<<", target: null, body: bodyNode ? bodyNode.text : "" };
  }

  // ---------- 복합 구조 ----------

  private redirected(node: Node): void {
    const body = node.childForFieldName("body");
    if (body && body.type !== "command") {
      const group = this.emptyCmd(node, "group");
      for (const r of node.namedChildren) {
        if (r && r.id !== body.id && r.type.endsWith("_redirect"))
          group.redirects.push(this.redirectOf(r));
      }
      this.push(group);
    }
    if (body) this.visit(body);
    const owner = body?.type === "command" ? this.commandOf(body) : null;
    for (const r of node.namedChildren) {
      if (!r || r.id === body?.id) continue;
      this.redirectChildren(r, owner);
    }
  }

  /** `cat <<E | bash` 처럼 히어독 노드 안에 파이프라인이 들어가는 tree-sitter 구조를 처리한다. */
  private redirectChildren(redirect: Node, owner: Cmd | null): void {
    for (const c of redirect.namedChildren) {
      if (!c) continue;
      if (c.type === "pipeline") this.pipeline(c, owner ? [owner] : []);
      else this.visit(c);
    }
  }

  /** 파이프라인의 각 단계를 연결한다. 반환값은 마지막 단계의 명령들. */
  private pipeline(node: Node, firstFrom: Cmd[]): Cmd[] {
    let prev = firstFrom;
    for (const el of node.namedChildren) {
      if (!el) continue;
      const stage = this.stageCmds(el);
      for (const cmd of stage) if (prev.length > 0) cmd.pipeFrom = prev;
      this.visit(el);
      prev = stage;
    }
    return prev;
  }

  private stageCmds(el: Node): Cmd[] {
    if (el.type === "command") return [this.commandOf(el)];
    if (el.type === "redirected_statement") {
      const body = el.childForFieldName("body");
      if (body?.type === "command") return [this.commandOf(body)];
    }
    return el.descendantsOfType("command").flatMap((n) => (n ? [this.commandOf(n)] : []));
  }
}

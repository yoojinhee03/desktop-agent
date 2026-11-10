// 규칙용 경로 글로브: ** 는 / 를 포함한 모든 문자, * 와 ? 는 / 를 제외한 문자.
// "dir/**" 는 dir 자신도 포함한다.

export interface CompiledGlob {
  source: string;
  regex: RegExp;
  /** 와일드카드 앞의 고정 부분(디렉터리). 상위 디렉터리 판정에 쓴다 */
  prefix: string;
}

export function expandHome(pattern: string, home: string): string {
  if (pattern === "~") return home;
  return pattern.startsWith("~/") ? home + pattern.slice(1) : pattern;
}

export function compileGlob(pattern: string, home: string): CompiledGlob {
  const abs = expandHome(pattern, home);
  return { source: pattern, regex: new RegExp(`^${toRegex(abs)}$`), prefix: staticPrefix(abs) };
}

function toRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      out += "(?:/.*)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function staticPrefix(abs: string): string {
  const wild = abs.search(/[*?]/);
  if (wild < 0) return abs;
  const cut = abs.lastIndexOf("/", wild);
  return cut <= 0 ? "/" : abs.slice(0, cut);
}

export function matchesAny(path: string, globs: CompiledGlob[]): boolean {
  return globs.some((g) => g.regex.test(path));
}

/** path가 글로브 고정 부분과 같거나 그 상위 디렉터리인지 (예: ~/.ssh 는 ~/.ssh/id_* 의 상위) */
export function isAncestorOf(path: string, g: CompiledGlob): boolean {
  if (g.prefix === "/") return path === "/";
  if (path === "/") return true;
  return g.prefix === path || g.prefix.startsWith(`${path}/`);
}

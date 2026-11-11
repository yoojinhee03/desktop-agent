// 승인 창에 보여줄 줄 단위 unified diff. 외부 의존성 없이 공통 앞뒤를 잘라낸 뒤 가운데만 LCS로 비교한다.

type Mark = " " | "-" | "+";

interface Op {
  mark: Mark;
  line: string;
}

/** 가운데 부분이 이보다 크면(줄 수 곱) LCS 대신 "전부 지우고 새로 씀"으로 보여준다 */
const MAX_LCS_CELLS = 250_000;

function commonPrefix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  let n = 0;
  while (n < a.length - prefix && n < b.length - prefix && a.at(-1 - n) === b.at(-1 - n)) n++;
  return n;
}

const ops = (mark: Mark, lines: string[]): Op[] => lines.map((line) => ({ mark, line }));

/** table[i][j] = a[i..]와 b[j..]의 최장 공통 부분열 길이 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const k = i * w + j;
      t[k] = a[i] === b[j] ? (t[k + w + 1] ?? 0) + 1 : Math.max(t[k + w] ?? 0, t[k + 1] ?? 0);
    }
  }
  return t;
}

function nextMark(a: string[], b: string[], t: Uint32Array, i: number, j: number): Mark {
  if (i < a.length && j < b.length && a[i] === b[j]) return " ";
  if (j >= b.length) return "-";
  if (i >= a.length) return "+";
  const w = b.length + 1;
  // 같은 자리에서는 지운 줄을 먼저 보여준다
  return (t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0) ? "-" : "+";
}

function middleOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_LCS_CELLS) return [...ops("-", a), ...ops("+", b)];
  const t = lcsTable(a, b);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const mark = nextMark(a, b, t, i, j);
    out.push({ mark, line: (mark === "+" ? b[j] : a[i]) ?? "" });
    if (mark !== "+") i++;
    if (mark !== "-") j++;
  }
  return out;
}

export function diffLines(a: string[], b: string[]): Op[] {
  const pre = commonPrefix(a, b);
  const suf = commonSuffix(a, b, pre);
  const mid = middleOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  return [...ops(" ", a.slice(0, pre)), ...mid, ...ops(" ", a.slice(a.length - suf))];
}

/** 바뀐 줄 앞뒤로 context줄씩 붙인 구간들. 겹치거나 붙으면 합친다 */
function hunkRanges(list: Op[], context: number): [number, number][] {
  const ranges: [number, number][] = [];
  list.forEach((op, i) => {
    if (op.mark === " ") return;
    const start = Math.max(0, i - context);
    const end = Math.min(list.length, i + context + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  return ranges;
}

const count = (list: Op[], skip: Mark) => list.filter((op) => op.mark !== skip).length;

function hunkHeader(list: Op[], [start, end]: [number, number]): string {
  const before = list.slice(0, start);
  const body = list.slice(start, end);
  const oldLen = count(body, "+");
  const newLen = count(body, "-");
  const oldStart = count(before, "+") + (oldLen > 0 ? 1 : 0);
  const newStart = count(before, "-") + (newLen > 0 ? 1 : 0);
  return `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`;
}

export interface DiffOptions {
  context?: number;
  /** 출력 최대 줄 수. 넘으면 잘라내고 남은 줄 수를 알린다 */
  maxLines?: number;
}

/** 빈 문자열은 줄이 없는 것으로 본다 (새 파일) */
const toLines = (text: string) => (text === "" ? [] : text.split("\n"));

/** 바뀐 것이 없으면 빈 문자열 */
export function unifiedDiff(oldText: string, newText: string, o: DiffOptions = {}): string {
  const list = diffLines(toLines(oldText), toLines(newText));
  const out: string[] = [];
  for (const range of hunkRanges(list, o.context ?? 3)) {
    out.push(hunkHeader(list, range));
    for (const op of list.slice(...range)) out.push(`${op.mark}${op.line}`);
  }
  const max = o.maxLines ?? 80;
  if (out.length <= max) return out.join("\n");
  return [...out.slice(0, max), `… (${out.length - max}줄 더 있음)`].join("\n");
}

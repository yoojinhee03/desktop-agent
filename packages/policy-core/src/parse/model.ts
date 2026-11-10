// 구문 트리에서 뽑아낸 판정용 모델. tree-sitter 노드는 판정 전에 해제되므로 필요한 값만 옮긴다.

export interface Word {
  /** 원문 그대로 */
  raw: string;
  /** 따옴표·이스케이프를 풀고 알려진 변수를 채운 값. 실행 전에 알 수 없으면 null */
  value: string | null;
  /** 따옴표 밖의 글로브 문자(*, ?, [)가 있어 셸이 펼칠 수 있는지 */
  glob: boolean;
  /** 이 단어 안의 $( ), 백틱, <( ) 에 들어 있는 명령 */
  inner: Cmd[];
  /** 단어 전체가 프로세스 치환 <( ) 인지 */
  procSubst: boolean;
  /** xargs·find -exec 처럼 실제 인자가 실행 중에 채워지는 자리라 하위 경로 전체로 판정해야 하는지 */
  implicit?: boolean;
  start: number;
  end: number;
}

export interface Redirect {
  /** >, >>, <, &>, >|, <<, <<<, >& 등 */
  op: string;
  /** 대상 파일. fd 복제(2>&1)·히어독이면 null */
  target: Word | null;
  /** 히어독·히어스트링 본문. 알 수 없으면 null */
  body: string | null;
}

export type CmdKind = "simple" | "declaration" | "group";

export interface Cmd {
  kind: CmdKind;
  argv: Word[];
  assigns: Array<{ name: string; value: string | null }>;
  redirects: Redirect[];
  /** 이 명령의 표준 입력으로 출력을 보내는 앞 단계 명령들(파이프) */
  pipeFrom: Cmd[];
  /** 원문에서의 위치 (JS 문자열 인덱스) */
  start: number;
  end: number;
}

export interface Script {
  source: string;
  cmds: Cmd[];
  /** 구문 오류가 있었는지. 있어도 부분 결과는 cmds에 담긴다 */
  error: boolean;
  /** 포크 밤 형태(자기 자신을 파이프로 다시 부르는 함수)가 있는지 */
  forkBomb: boolean;
}

/** 해석 중 알게 된 변수·별칭 값. 판정용 근사치다. */
export interface Env {
  vars: Map<string, string>;
  aliases: Map<string, string>;
}

export function newEnv(vars: Record<string, string>): Env {
  return { vars: new Map(Object.entries(vars)), aliases: new Map() };
}

/** 단어의 정적 값 목록. 하나라도 알 수 없으면 null */
export function staticArgs(words: Word[]): string[] | null {
  const out: string[] = [];
  for (const w of words) {
    if (w.value === null) return null;
    out.push(w.value);
  }
  return out;
}

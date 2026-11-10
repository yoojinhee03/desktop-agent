// "설계: 정책 엔진" > 판정 흐름의 타입을 그대로 옮긴 것.
// 설계 문서에서 이름만 나오고 정의가 없는 ChangePreview와, decide()의 입력 타입 ToolCall은
// 뼈대용 최소 정의다. 바꿀 때는 세션 A·B 양쪽에 알린다.
// 세션 B(정책 엔진) 추가분: 기존 필드는 그대로 두고 필드·값만 추가했다.

export type Grade = 0 | 1 | 2 | 3 | "block";

export type PolicyAction = "allow" | "ask" | "deny" | "rewrite";

/**
 * - local_only: 자격증명·브라우저 프로필 원문을 읽는다. 결과는 로컬에서만 처리(원문 전송 금지).
 * - dynamic_code: eval·python -c 등 동적 코드. 승인 창에 코드를 그대로 보여준다.
 */
export type PolicyFlag =
  | "after_external_content"
  | "unparseable"
  | "llm_judged"
  | "local_only"
  | "dynamic_code";

/** 승인 창에 보여줄 영향 범위: 대상 경로·개수·크기·diff */
export interface ChangePreview {
  paths: string[];
  fileCount?: number;
  totalBytes?: number;
  diff?: string;
}

/** 이 호출이 실행되면 생기는 변화. 어댑터가 실행 후 recordExecution()으로 세션에 반영한다. */
export interface DecisionEffects {
  /** 이 호출이 쓰는 파일(절대 경로). 나중에 실행되면 내용까지 판정한다. */
  writes: string[];
  /** 자격증명 내용이 복사될 수 있는 경로. 이후 자격증명과 같은 등급으로 다룬다. */
  tainted: string[];
}

export interface PolicyDecision {
  grade: Grade;
  action: PolicyAction;
  ruleIds: string[]; // 예: ['cmd.rm', 'path.sensitive.ssh']
  reasons: string[]; // 승인 창·로그용 설명
  rewrite?: string; // 예: rm → 휴지통 이동 명령
  preview?: ChangePreview; // 대상 경로·개수·크기·diff
  flags: PolicyFlag[];
  /** 세션 허용 키(규칙 ID + 범위). 2등급이고 모든 근거가 세션 허용 대상일 때만 채운다. */
  allowKeys?: string[];
  effects?: DecisionEffects;
}

/** 판정 입력: 도구 이름 + 입력값 (shell 명령, 파일 경로와 내용, URL 등) */
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** 파일 시스템 조회. 판정 코어는 이 인터페이스로만 디스크를 본다(테스트에서는 가짜로 바꾼다). */
export interface FsProbe {
  /** 심볼릭 링크를 따라간 실제 경로. 없는 경로는 존재하는 가장 가까운 부모까지 해석한다. */
  realpath(path: string): string;
  /** 절대 경로 글로브를 펼친다. 일치하는 것이 없으면 빈 배열. */
  glob(pattern: string): string[];
  stat(path: string): FileStat | null;
  /** 경로 아래 파일 개수와 총 크기(디렉터리는 재귀). 없으면 0. */
  measure(path: string): { files: number; bytes: number };
  /** 텍스트 파일 내용. 없거나 너무 크거나 이진 파일이면 null. */
  readText(path: string): string | null;
}

export interface FileStat {
  type: "file" | "dir" | "other";
  size: number;
  executable: boolean;
}

/** 세션 동안 쌓이는 상태. 순수 데이터라 직렬화할 수 있다. */
export interface SessionState {
  /** 에이전트가 이번 세션에 쓴 파일(절대 경로) */
  writtenFiles: string[];
  /** 자격증명 내용이 복사됐을 수 있는 파일(절대 경로) */
  taintedFiles: string[];
  /** "이번 세션에서 같은 종류 허용"으로 저장된 키 */
  allowKeys: string[];
  /** 현재 사용자 요청에서 외부 콘텐츠를 읽었는지 */
  externalContent: boolean;
}

export interface DecideContext {
  home: string;
  cwd: string;
  fs: FsProbe;
  session: SessionState;
  /** 정책 파일·감사 로그·체크포인트 등 에이전트 내부 경로(글로브). 쓰기·삭제는 차단 */
  agentPaths: string[];
}

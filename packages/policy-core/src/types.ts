// "설계: 정책 엔진" > 판정 흐름의 타입을 그대로 옮긴 것.
// 설계 문서에서 이름만 나오고 정의가 없는 ChangePreview와, decide()의 입력 타입 ToolCall은
// 뼈대용 최소 정의다. 바꿀 때는 세션 A·B 양쪽에 알린다.

export type Grade = 0 | 1 | 2 | 3 | "block";

export type PolicyAction = "allow" | "ask" | "deny" | "rewrite";

export type PolicyFlag = "after_external_content" | "unparseable" | "llm_judged";

/** 승인 창에 보여줄 영향 범위: 대상 경로·개수·크기·diff */
export interface ChangePreview {
  paths: string[];
  fileCount?: number;
  totalBytes?: number;
  diff?: string;
}

export interface PolicyDecision {
  grade: Grade;
  action: PolicyAction;
  ruleIds: string[]; // 예: ['cmd.rm', 'path.sensitive.ssh']
  reasons: string[]; // 승인 창·로그용 설명
  rewrite?: string; // 예: rm → 휴지통 이동 명령
  preview?: ChangePreview; // 대상 경로·개수·크기·diff
  flags: PolicyFlag[];
}

/** 판정 입력: 도구 이름 + 입력값 (shell 명령, 파일 경로와 내용, URL 등) */
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

// 규칙(정규식) 기반 시크릿 패턴. 순서가 중요하다: 구체적인 형식을 먼저, 일반 할당문 패턴을 마지막에.
// 각 패턴은 마스킹할 부분만 바꾼다(키 이름·구분자는 남겨 모델이 맥락을 이해하게 한다).

export interface SecretPattern {
  kind: string;
  regex: RegExp;
  /** 매치 하나를 받아 바꿀 문자열을 돌려준다. null이면 바꾸지 않는다(오탐 회피) */
  replace: (match: RegExpMatchArray, tag: string) => string | null;
}

const whole = (_m: RegExpMatchArray, tag: string) => tag;

/** 그룹 1(앞부분)은 남기고 그룹 2(값)만 가린다 */
const keepPrefix = (m: RegExpMatchArray, tag: string) => `${m[1] ?? ""}${tag}`;

const PLACEHOLDER = /^(\$|<|\[MASKED:|\*{3,}|x{3,}$|changeme$|example$|your[_-])/i;

/** 일반 할당문(password=…)의 값이 실제 비밀값처럼 보일 때만 가린다 */
function assignmentValue(m: RegExpMatchArray, tag: string): string | null {
  const [, name = "", sep = "", quote = "", value = ""] = m;
  if (/^\d+$/.test(value) || PLACEHOLDER.test(value)) return null;
  return `${name}${sep}${quote}${tag}${quote}`;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private_key",
    // END가 잘린 출력도 끝까지 가린다
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole,
  },
  { kind: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole },
  {
    kind: "aws_secret_key",
    regex: /(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})/gi,
    replace: keepPrefix,
  },
  { kind: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, replace: whole },
  { kind: "github_token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, replace: whole },
  { kind: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: whole },
  { kind: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, replace: whole },
  { kind: "slack_token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: whole },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: whole },
  { kind: "stripe_key", regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replace: whole },
  { kind: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: whole },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: whole,
  },
  {
    kind: "url_credentials",
    regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(?=@)/gi,
    replace: keepPrefix,
  },
  {
    kind: "bearer_token",
    regex: /(authorization["']?\s*[:=]\s*["']?bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/gi,
    replace: keepPrefix,
  },
  {
    kind: "generic_secret",
    regex:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?)(\s*[:=]\s*)(["']?)([^\s"'#,;]{6,})\3/gi,
    replace: assignmentValue,
  },
];

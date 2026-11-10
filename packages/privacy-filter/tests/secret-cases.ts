// 시크릿 마스킹 테스트셋 (작업 보드 #11). M2 로컬 모델 비교에도 같은 세트를 쓴다.
// 가짜 값은 실행할 때 조립한다: 진짜처럼 생긴 토큰 문자열을 공개 저장소에 그대로 두면
// GitHub 비밀 스캔에 걸리거나 실제 유출로 오해받을 수 있다. 실제 계정과 무관한 값이다.

const ALNUM = "A7b2C9d4E1f6G3h8J5k0L2m7N4p9Q1r6S3t8U5v0W2x7Y4z9";
const UPPER = "QWERTYUIOPASDFGHJKLZXCVBNM2345";

/** 결정적인 가짜 문자열 (같은 길이면 항상 같은 값) */
export function fake(n: number, alphabet = ALNUM): string {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[(i * 7 + 3) % alphabet.length];
  return s;
}

export interface PositiveCase {
  name: string;
  kind: string;
  /** 출력에 남으면 안 되는 비밀값 */
  secret: string;
  text: string;
}

const awsKey = `AKIA${fake(16, UPPER)}`;
const awsSecret = fake(40, `${ALNUM}/+`);
const ghToken = `gh${"p"}_${fake(36)}`;
const ghPat = `github${"_pat_"}${fake(30)}_${fake(20)}`;
const anthropic = `sk-${"ant"}-api03-${fake(40)}`;
const openai = `sk-${"proj"}-${fake(48)}`;
const slack = `xo${"xb"}-1234567890-${fake(24)}`;
const google = `AI${"za"}${fake(35)}`;
const stripe = `sk_${"live"}_${fake(24)}`;
const npm = `np${"m"}_${fake(36)}`;
const jwt = `eyJ${fake(20)}.eyJ${fake(30)}.${fake(32)}`;
const pkBody = `${fake(64)}\n${fake(64)}\n${fake(20)}=`;
const pkHeader = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const pkFooter = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");

export const POSITIVE: PositiveCase[] = [
  {
    name: "AWS 액세스 키",
    kind: "aws_access_key",
    secret: awsKey,
    text: `aws_access_key_id = ${awsKey}`,
  },
  {
    name: "AWS 시크릿 키 (credentials 파일)",
    kind: "aws_secret_key",
    secret: awsSecret,
    text: `[default]\naws_secret_access_key = ${awsSecret}\n`,
  },
  { name: "GitHub 토큰", kind: "github_token", secret: ghToken, text: `GITHUB_TOKEN=${ghToken}` },
  { name: "GitHub 세분화 토큰", kind: "github_token", secret: ghPat, text: `token: ${ghPat}` },
  {
    name: "Anthropic API 키",
    kind: "anthropic_key",
    secret: anthropic,
    text: `export KEY="${anthropic}"`,
  },
  { name: "OpenAI API 키", kind: "openai_key", secret: openai, text: `OPENAI=${openai}` },
  { name: "Slack 토큰", kind: "slack_token", secret: slack, text: `slack: ${slack}` },
  { name: "Google API 키", kind: "google_api_key", secret: google, text: `key=${google}&q=1` },
  { name: "Stripe 키", kind: "stripe_key", secret: stripe, text: `STRIPE=${stripe}` },
  {
    name: "npm 토큰",
    kind: "npm_token",
    secret: npm,
    text: `//registry.npmjs.org/:_authToken=${npm}`,
  },
  { name: "JWT", kind: "jwt", secret: jwt, text: `cookie session=${jwt}; Path=/` },
  {
    name: "개인키 블록",
    kind: "private_key",
    secret: pkBody.slice(0, 64),
    text: `${pkHeader}\n${pkBody}\n${pkFooter}\n`,
  },
  {
    name: "잘린 개인키 블록 (END 없음)",
    kind: "private_key",
    secret: pkBody.slice(0, 64),
    text: `head -3 id_ed25519\n${pkHeader}\n${pkBody.slice(0, 64)}`,
  },
  {
    name: "URL 안의 비밀번호",
    kind: "url_credentials",
    secret: "S3cr3tPassw0rd",
    text: "DATABASE_URL=postgres://app:S3cr3tPassw0rd@db.internal:5432/app",
  },
  {
    name: "Bearer 토큰 헤더",
    kind: "bearer_token",
    secret: fake(32),
    text: `Authorization: Bearer ${fake(32)}`,
  },
  {
    name: ".env 비밀번호",
    kind: "generic_secret",
    secret: "hunter2-Prod!",
    text: "DB_PASSWORD=hunter2-Prod!",
  },
  {
    name: "YAML client_secret",
    kind: "generic_secret",
    secret: fake(24),
    text: `oauth:\n  client_secret: "${fake(24)}"\n`,
  },
  {
    name: "JSON apiKey",
    kind: "generic_secret",
    secret: fake(28),
    text: `{"apiKey": "${fake(28)}"}`,
  },
];

/** 마스킹되면 안 되는 비슷한 문자열 (오탐 확인) */
export const NEGATIVE: { name: string; text: string }[] = [
  { name: "일반 파일 목록", text: "견적서_2026.pdf\nreport.pdf\narchive/invoice-old.pdf" },
  { name: "숫자 토큰 수", text: "token_count = 123456" },
  { name: "환경변수 참조", text: 'password="$DB_PASSWORD"' },
  { name: "자리표시자", text: "API_KEY=<your-api-key>" },
  { name: "이미 가린 값", text: "secret: ****" },
  { name: "git 커밋 해시", text: "commit 3d3c42e5aac5ba805825da76410c181273ba90b1" },
  { name: "sha256 체크섬", text: `sha256:${"ab12".repeat(16)}` },
  { name: "공개키", text: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fake(40)} me@host` },
  { name: "평문 문장", text: "비밀번호를 바꾸려면 설정 > 보안으로 가세요. The token expired." },
  { name: "인증 없는 URL", text: "https://github.com/yoojinhee03/desktop-agent/pull/3" },
  { name: "UUID", text: "requestId=e7df55b2-2f3c-4a1e-9c7d-1b2a3c4d5e6f" },
];

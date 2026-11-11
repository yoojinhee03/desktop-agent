import { createInterface } from "node:readline/promises";
import type { PolicyDecision, PolicyFlag, ToolCall } from "@desktop-agent/policy-core";
import type { ApprovalView } from "./view/approval-view.ts";

/** approved_for_session: "이번 세션에서 같은 종류 허용" (2등급이고 세션 허용 키가 있을 때만) */
export type ApprovalAnswer = "approved" | "approved_for_session" | "rejected";

/** 수정 요청: 실행하지 않고, 사용자의 말을 에이전트에게 돌려줘 방법을 바꾸게 한다 */
export interface RevisionRequest {
  answer: "revision_requested";
  feedback: string;
}

export type ApprovalReply = ApprovalAnswer | RevisionRequest;

/** ask 판정을 사람에게(또는 테스트 스크립트에) 물어보는 자리. M3에서 Electron 승인 창으로 바뀐다. */
export interface Approver {
  /** 감사 로그의 승인자 필드에 남는 이름 (예: user:terminal, script:sandbox-readonly) */
  readonly id: string;
  /** view: 판정과 함께 보여줄 내용(diff 등). 화면 표시 전용 */
  ask(call: ToolCall, decision: PolicyDecision, view?: ApprovalView): Promise<ApprovalReply>;
}

/** 그대로 찍으면 안 되는 문자 범위: C0·C1 제어 문자(탭·줄바꿈 제외), 폭 없는 문자, 줄·문단 구분, 방향 제어 */
const UNSAFE_RANGES: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

const isUnsafe = (code: number) => UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

function escapeChar(code: number): string {
  return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
}

/**
 * 터미널 제어 문자를 눈에 보이는 형태로 바꾼다. 명령이나 파일 내용에 \r·이스케이프 코드가 있으면
 * 승인 창의 앞 글자를 덮어써 실제와 다른 명령으로 보이게 할 수 있다.
 * 유니코드 방향 제어·폭 없는 문자(U+202E 등)도 글자 순서를 뒤집어 보이게 하므로 함께 바꾼다.
 */
export function printable(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return isUnsafe(code) ? escapeChar(code) : ch;
  }).join("");
}

export function describeCall(call: ToolCall): string {
  const command = call.input.command;
  return typeof command === "string" ? command : JSON.stringify(call.input);
}

/** 설계: 세션 허용은 2등급만, 그리고 판정 근거가 모두 세션 허용 대상일 때(allowKeys가 채워짐)만 */
export function canAllowForSession(decision: PolicyDecision): boolean {
  return decision.grade === 2 && (decision.allowKeys?.length ?? 0) > 0;
}

/** 승인 창에 보일 표시 문구 (설계: 외부 내용을 읽은 뒤의 2등급 이상 작업은 "외부 내용 읽은 후"로 알린다) */
const FLAG_LABELS: Record<PolicyFlag, string> = {
  after_external_content: "⚠ 외부 내용 읽은 후 (웹 페이지 등의 지시로 생긴 요청일 수 있음)",
  unparseable: "명령을 완전히 분석하지 못함",
  llm_judged: "모델 보조 판정",
  local_only: "자격증명 등 로컬 처리만 허용된 내용",
  dynamic_code: "동적 코드 실행 (코드를 그대로 확인하세요)",
};

export function describeFlags(flags: readonly PolicyFlag[]): string[] {
  return flags.map((f) => FLAG_LABELS[f] ?? f);
}

function previewLines(decision: PolicyDecision, view: ApprovalView | undefined): string[] {
  const lines: string[] = [];
  const p = decision.preview;
  if (p) {
    const size = p.totalBytes === undefined ? "" : `, ${p.totalBytes}바이트`;
    lines.push(
      `  대상: ${p.fileCount ?? p.paths.length}개${size} · ${p.paths.slice(0, 5).join(", ")}`,
    );
  }
  if (view?.diff) lines.push("  바뀌는 내용:", ...view.diff.split("\n").map((l) => `    ${l}`));
  else if (view?.note) lines.push(`  바뀌는 내용: (${view.note})`);
  return lines;
}

function promptLines(call: ToolCall, decision: PolicyDecision, view?: ApprovalView): string[] {
  const lines = [
    `\n[승인 요청] 등급 ${decision.grade} · ${decision.ruleIds.join(", ")}`,
    `  도구: ${call.toolName}`,
    `  내용: ${describeCall(call)}`,
    // 설계: 승인 창에는 "실제 실행될 명령"을 보여준다 (rm → 휴지통 이동 등 치환된 경우)
    ...(decision.rewrite ? [`  실제 실행: ${decision.rewrite}`] : []),
    `  사유: ${decision.reasons.join(" / ")}`,
  ];
  for (const label of describeFlags(decision.flags)) lines.push(`  표시: ${label}`);
  lines.push(...previewLines(decision, view));
  return lines.map(printable);
}

type Choice = ApprovalAnswer | "revise";

function parseChoice(raw: string, sessionAllowed: boolean): Choice {
  const answer = raw.trim().toLowerCase();
  if (answer === "y" || answer === "yes") return "approved";
  if (answer === "s" && sessionAllowed) return "approved_for_session";
  if (answer === "r") return "revise";
  return "rejected"; // 알아들을 수 없는 답은 거절
}

function questionText(sessionAllowed: boolean): string {
  const session = sessionAllowed ? " / s: 이번 세션에서 같은 종류 허용" : "";
  return `  실행할까요? (y: 실행${session} / r: 수정 요청 / n: 거절) `;
}

type Ask = (question: string) => Promise<string>;

/** r을 고르면 무엇을 바꿀지 묻는다. 빈 답이면 거절로 처리한다 */
async function answerFor(choice: Choice, question: Ask): Promise<ApprovalReply> {
  if (choice !== "revise") return choice;
  const feedback = (
    await question("  어떻게 바꿀까요? (예: 휴지통 말고 보관 폴더로 옮겨줘) ")
  ).trim();
  return feedback === "" ? "rejected" : { answer: "revision_requested", feedback };
}

/** 터미널 승인. y는 이번만 승인, s는 세션 허용(가능할 때만), r은 수정 요청, 그 밖의 답은 모두 거절이다. */
export function createTerminalApprover(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Approver {
  return {
    id: "user:terminal",
    async ask(call, decision, view) {
      const rl = createInterface({ input, output });
      try {
        output.write(`${promptLines(call, decision, view).join("\n")}\n`);
        const sessionAllowed = canAllowForSession(decision);
        const choice = parseChoice(await rl.question(questionText(sessionAllowed)), sessionAllowed);
        return await answerFor(choice, (q) => rl.question(q));
      } finally {
        rl.close();
      }
    },
  };
}

/** 테스트·리플레이용: 판단 함수를 그대로 승인 결과로 쓴다. */
export function createScriptedApprover(
  id: string,
  judge: (call: ToolCall, decision: PolicyDecision, view?: ApprovalView) => ApprovalReply,
): Approver {
  return { id: `script:${id}`, ask: async (call, decision, view) => judge(call, decision, view) };
}

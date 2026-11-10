import {
  allowForSession,
  type DecideContext,
  emptySession,
  endUserRequest,
  markExternalContent,
  type PolicyDecision,
  recordExecution,
  type SessionState,
} from "@desktop-agent/policy-core";

/** 판정 문맥 중 세션 상태를 뺀 부분 (홈, 작업 폴더, 파일 조회, 에이전트 내부 경로) */
export type BaseContext = Omit<DecideContext, "session">;

const WEB_RULE = "tool.web";

/**
 * 정책 엔진의 세션 상태(작성 파일, 오염 경로, 세션 허용, 외부 콘텐츠)를 들고 있는 곳.
 * policy-core의 decide()는 순수 함수라 상태를 어댑터가 보관하고 판정마다 넘긴다.
 */
export class SessionStore {
  private state: SessionState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly base: BaseContext,
    initial: SessionState = emptySession(),
  ) {
    this.state = initial;
  }

  context(): DecideContext {
    return { ...this.base, session: this.state };
  }

  snapshot(): SessionState {
    return this.state;
  }

  /**
   * 판정 하나를 끝까지(판정 → 승인 → 상태 반영) 한 번에 하나씩 처리한다.
   * 병렬 도구 호출에서 승인 프롬프트가 섞이거나, 상태 갱신이 서로 덮어쓰지 않게 한다.
   */
  serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * 실행이 허용된 호출을 반영한다. 실제 실행 전에 기록하므로 작성 파일을 넓게 잡는 쪽(더 엄격한 쪽)으로 틀린다.
   */
  applyExecuted(decision: PolicyDecision): void {
    this.state = recordExecution(this.state, decision);
    if (decision.ruleIds.includes(WEB_RULE)) this.state = markExternalContent(this.state);
  }

  allowForSession(decision: PolicyDecision): void {
    this.state = allowForSession(this.state, decision);
  }

  /** 사용자 요청 하나가 끝났을 때: 외부 콘텐츠 표시를 내린다 (세션 허용·작성 파일은 유지) */
  endUserRequest(): void {
    this.state = endUserRequest(this.state);
  }
}

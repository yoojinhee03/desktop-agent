// "설계: 로컬 LLM 연동" > 인터페이스. 도구 결과가 Claude로 가기 전에 반드시 지나가는 자리.
import type { PolicyFlag } from "@desktop-agent/policy-core";

/** 도구 실행 결과 (필터 입력) */
export interface ToolOutput {
  toolName: string;
  text: string;
  /** 이 호출의 정책 판정 표시. local_only면 원문을 클라우드로 보내지 않는다 */
  flags: readonly PolicyFlag[];
}

/** 마스킹 한 종류의 기록. 원문은 남기지 않고 종류와 개수만 남긴다 */
export interface MaskingRecord {
  kind: string;
  count: number;
}

export interface FilteredOutput {
  text: string;
  maskings: MaskingRecord[];
  /** 내용 전체를 보내지 않았으면 그 이유 */
  withheld: string | null;
}

export interface PrivacyFilter {
  /** 도구 실행 결과를 Claude로 보내기 전에 호출 */
  process(input: ToolOutput): Promise<FilteredOutput>;
}

/** 민감 원문을 PC 안에서 처리할 로컬 모델. M1은 인터페이스만, 구현은 M2(Ollama) */
export interface SensitiveSpan {
  start: number;
  end: number;
  kind: string;
}

export interface LocalModel {
  available(): Promise<boolean>;
  summarize(text: string, purpose: string): Promise<string>;
  detectSensitive(text: string): Promise<SensitiveSpan[]>;
  embed(text: string): Promise<number[]>;
}

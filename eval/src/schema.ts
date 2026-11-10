// 시나리오 YAML 형식 (테스트: 평가 하네스와 레드팀 > 평가 하네스).
// 요청, 초기 환경 픽스처, 승인 규칙, 기대 승인 횟수, 결과 검증을 한 파일에 둔다.
import { z } from "zod";

const Fixture = z.object({
  /** ~/로 시작하는 경로. count가 있으면 {n}을 1..count로 바꿔 여러 개 만든다 */
  path: z.string().startsWith("~/"),
  content: z.string().default(""),
  count: z.number().int().positive().max(5000).optional(),
});

const Check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("missing"), path: z.string() }),
  z.object({ type: z.literal("exists"), path: z.string() }),
  z.object({ type: z.literal("file_contains"), path: z.string(), text: z.string() }),
  z.object({ type: z.literal("glob_count"), pattern: z.string(), count: z.number().int() }),
  z.object({
    type: z.literal("in_trash"),
    name_prefix: z.string().min(3),
    min_count: z.number().int().positive().default(1),
  }),
  z.object({ type: z.literal("shell"), command: z.string(), stdout: z.string() }),
  z.object({
    type: z.literal("reply_mentions"),
    /** 그룹마다 단어 하나 이상이 최종 답변에 있어야 한다 */
    all_of: z.array(z.array(z.string()).min(1)).min(1),
  }),
]);

const Expect = z.object({
  min_approvals: z.number().int().min(0).default(0),
  max_approvals: z.number().int().min(0),
  /** 한 번 이상 승인돼야 하는 규칙 ID */
  approved_rules: z.array(z.string()).default([]),
  /** 한 번 이상 나와야 하는 처리 결과 (auto_allowed, rewritten …) */
  outcomes_include: z.array(z.string()).default([]),
  /** 실제 실행된 셸 명령 중 하나 이상이 맞아야 하는 정규식 */
  executed_include: z.array(z.string()).default([]),
  /** 실제 실행된 셸 명령 어느 것도 맞으면 안 되는 정규식 */
  executed_exclude: z.array(z.string()).default([]),
});

export const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  request: z.string().min(1),
  /** 에이전트 실행 전에 실행기가 직접 돌리는 준비 명령 (VM 안에서만) */
  before: z.array(z.string()).default([]),
  fixtures: z.array(Fixture).default([]),
  /** 승인 요청에 이 규칙이 하나라도 있으면 승인, 아니면 거절 */
  approve: z.object({ rules: z.array(z.string()).min(1) }).optional(),
  expect: Expect,
  checks: z.array(Check).default([]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioCheck = z.infer<typeof Check>;
export type ScenarioFixture = z.infer<typeof Fixture>;

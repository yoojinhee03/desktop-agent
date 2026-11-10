// rules/*.yaml 형식. 잘못된 규칙 파일은 로드할 때 거부한다(개발: 기술 스택 > 규칙 파일).
import { z } from "zod";

export const GradeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("block"),
]);

const RuleId = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "규칙 ID는 소문자·숫자·밑줄·점만");
const OneOrMany = z.union([z.string(), z.array(z.string()).min(1)]);

export const MatchSchema = z
  .object({
    /** 명령 이름(경로를 뗀 이름). 여러 개면 그중 하나 */
    command: OneOrMany,
    /** 첫 번째 옵션 아닌 인자 */
    subcommand: z.array(z.string()).min(1).optional(),
    /** 인자 중 하나가 정확히 같음 */
    args_any: z.array(z.string()).min(1).optional(),
    /** 인자 중 하나가 이 문자열로 시작 */
    args_prefix_any: z.array(z.string()).min(1).optional(),
    /** 인자 중 하나가 정규식과 일치 */
    args_regex_any: z.array(z.string()).min(1).optional(),
    /** 옵션 중 하나. "-r"은 -rf 같은 묶음 안에서도, "--force"는 --force=… 도 찾는다 */
    flags_any: z.array(z.string().regex(/^-/)).min(1).optional(),
    /** 인자가 하나도 없을 때만 */
    no_args: z.literal(true).optional(),
    /** 인자가 정확히 이것 하나일 때만 */
    sole_arg_any: z.array(z.string()).min(1).optional(),
    /** 인자가 정확히 이것 하나면 일치하지 않음 (예: python --version) */
    unless_sole_arg: z.array(z.string()).min(1).optional(),
  })
  .strict();

export const PathSpecSchema = z
  .object({
    op: z.enum(["read", "write", "delete", "meta", "upload"]),
    /** 옵션이 아닌 인자 중 어느 것을 경로로 볼지 */
    args: z.enum(["all", "first", "last", "all_but_last", "after_first"]).default("all"),
    /** 디렉터리 하위 전체에 작용하는지: 항상 / 안 함 / -r·-R·--recursive 옵션이 있을 때 */
    recursive: z.enum(["always", "never", "flag"]).default("never"),
    /** 대상이 홈 밖이면 적용할 최소 등급 (예: 홈 밖 chmod는 3) */
    outside_home: GradeSchema.optional(),
  })
  .strict();

export const HANDLERS = [
  "wrapper",
  "shell",
  "eval",
  "source",
  "interpreter",
  "awk",
  "xargs",
  "find",
  "rm",
  "dd",
  "curl",
  "wget",
  "transfer",
  "open",
  "cd",
  "ssh",
  "scheduler",
  "docker",
  "git_config",
] as const;

export const CommandRuleSchema = z
  .object({
    id: RuleId,
    match: MatchSchema,
    grade: GradeSchema,
    reason: z.string().min(1),
    paths: z.union([PathSpecSchema, z.array(PathSpecSchema)]).optional(),
    handler: z.enum(HANDLERS).optional(),
    /** 이 명령이 외부로 데이터를 보낼 수 있는지 (자격증명 유출 판정에 쓴다) */
    network: z.boolean().default(false),
    /** 2등급일 때 "이번 세션에서 같은 종류 허용" 대상인지 */
    session_allow: z.boolean().default(true),
    /** 같은 명령에 다른(fallback 아닌) 규칙이 하나도 맞지 않을 때만 적용 */
    fallback: z.boolean().default(false),
  })
  .strict();

export const PathClassSchema = z
  .object({
    id: RuleId,
    globs: z.array(z.string()).min(1),
    except: z.array(z.string()).default([]),
    read: GradeSchema,
    write: GradeSchema,
    /** 업로드 대상일 때 등급. 없으면 업로드 규칙 등급만 적용 */
    upload: GradeSchema.optional(),
    /** 읽으면 local_only 표시 (원문 전송 금지) */
    local_only: z.boolean().default(false),
    /** 자격증명 성격: 네트워크로 흘러가면 차단, 복사본은 오염 경로로 추적 */
    credential: z.boolean().default(false),
    /** 이 경로의 상위 디렉터리를 재귀로 다룰 때도 이 등급을 적용 (rm -rf ~/.ssh 등) */
    guard_ancestors: z.boolean().default(false),
    reason: z.string().min(1),
  })
  .strict();

/** 코드 핸들러가 내는 판정의 등급·설명. 등급은 코드가 아니라 규칙 파일에 둔다. */
export const EngineRuleSchema = z
  .object({
    id: RuleId,
    grade: GradeSchema,
    reason: z.string().min(1),
    session_allow: z.boolean().default(false),
  })
  .strict();

export const CodeTokenSchema = z
  .object({
    id: RuleId,
    /** 동적 코드(python -c, osascript -e 등) 안에 이 문자열이 있으면 적용 */
    tokens: z.array(z.string()).min(1),
    grade: GradeSchema,
    reason: z.string().min(1),
  })
  .strict();

export const DefaultsSchema = z
  .object({
    max_shell_depth: z.number().int().min(1).max(5),
    bulk_delete: z
      .object({ file_count_gt: z.number().int(), total_bytes_gt: z.number().int() })
      .strict(),
    trash_command: z.string().min(1),
  })
  .strict();

export const RuleFileSchema = z
  .object({
    version: z.literal(1),
    defaults: DefaultsSchema,
    path_classes: z.array(PathClassSchema).min(1),
    commands: z.array(CommandRuleSchema).min(1),
    network: z.array(CommandRuleSchema).min(1),
    engine: z.array(EngineRuleSchema).min(1),
    code_tokens: z.array(CodeTokenSchema).default([]),
  })
  .strict();

export type RuleFile = z.infer<typeof RuleFileSchema>;
export type CommandRule = z.infer<typeof CommandRuleSchema>;
export type PathClass = z.infer<typeof PathClassSchema>;
export type PathSpec = z.infer<typeof PathSpecSchema>;
export type EngineRule = z.infer<typeof EngineRuleSchema>;
export type Handler = (typeof HANDLERS)[number];

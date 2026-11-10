import type { Cmd, Word } from "../../parse/model.ts";
import type { CommandRule } from "../../rules/schema.ts";
import type { CmdInfo, JudgeCtx } from "../state.ts";

export interface HandlerCall {
  cmd: Cmd;
  /** 명령 이름 단어 (치환 위치 계산용) */
  head: Word;
  name: string;
  /** 명령 이름 뒤의 인자 */
  args: Word[];
  info: CmdInfo;
  rule: CommandRule;
}

export type HandlerFn = (jc: JudgeCtx, call: HandlerCall) => void;

/** 판정용 가짜 단어 (xargs 입력, find {} 자리 등) */
export function syntheticWord(
  value: string | null,
  like: Word | undefined,
  implicit = false,
): Word {
  return {
    raw: value ?? "",
    value,
    glob: false,
    inner: [],
    procSubst: false,
    implicit,
    start: like?.start ?? 0,
    end: like?.end ?? 0,
  };
}

/** 안쪽 명령을 위한 가짜 Cmd. 위치는 원래 명령의 것을 쓴다 */
export function innerCmd(outer: Cmd, argv: Word[]): Cmd {
  return { ...outer, kind: "simple", argv, assigns: [], redirects: [] };
}

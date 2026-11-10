// tests/cases/*.yaml 판정 케이스를 읽어 실행하는 도우미. 명령은 실행하지 않고 판정만 한다.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { decide } from "../../src/decide.ts";
import { gradeRank } from "../../src/grade.ts";
import { GradeSchema } from "../../src/rules/schema.ts";
import { emptySession } from "../../src/session.ts";
import type { DecideContext, PolicyDecision } from "../../src/types.ts";
import { type FakeEntry, fakeFs } from "./fake-fs.ts";

export const HOME = "/Users/test";
export const CWD = `${HOME}/project`;

const EntrySchema = z
  .object({
    size: z.number().optional(),
    content: z.string().optional(),
    executable: z.boolean().optional(),
    link: z.string().optional(),
    dir: z.boolean().optional(),
  })
  .strict();

const CaseSchema = z
  .object({
    id: z.string(),
    command: z.string(),
    note: z.string().optional(),
    /** 처음 판정에서 기대보다 낮게 나와 규칙·엔진을 고친 경우, 그 기록 */
    found: z.string().optional(),
    /** 이 케이스에만 추가할 가짜 파일 ("~/" 사용 가능) */
    fs: z.record(z.string(), EntrySchema).default({}),
    /** 폴더 하나에 같은 크기 파일 N개 만들기 */
    bulk: z.object({ dir: z.string(), count: z.number(), size: z.number() }).strict().optional(),
    written: z.array(z.string()).default([]),
    expect: z
      .object({
        grade: GradeSchema.optional(),
        min_grade: GradeSchema.optional(),
        action: z.enum(["allow", "ask", "deny", "rewrite"]).optional(),
        rule_ids_include: z.array(z.string()).optional(),
        flags_include: z.array(z.string()).optional(),
        rewrite_contains: z.string().optional(),
        file_count: z.number().optional(),
      })
      .strict(),
  })
  .strict();

export type JudgeCase = z.infer<typeof CaseSchema>;

export function loadCases(file: string): JudgeCase[] {
  const raw = parseYaml(readFileSync(new URL(`../cases/${file}`, import.meta.url), "utf8"));
  return z.array(CaseSchema).parse(raw);
}

/** 모든 케이스가 공유하는 홈 폴더 모양 */
const BASE_FS: Record<string, FakeEntry> = {
  "~/Downloads/a.pdf": { size: 2_000 },
  "~/Downloads/b.zip": { size: 5_000 },
  "~/.ssh/id_rsa": { content: "-----BEGIN OPENSSH PRIVATE KEY-----" },
  "~/.ssh/id_rsa.pub": { content: "ssh-ed25519 AAAA" },
  "~/.ssh/config": { content: "Host *" },
  "~/.aws/credentials": { content: "[default]\naws_access_key_id=AKIA" },
  "~/.zshrc": { content: "export PATH=$PATH" },
  "~/project/README.md": { content: "# demo" },
  "~/project/.env": { content: "TOKEN=x" },
  "~/Library/Keychains/login.keychain-db": { size: 10 },
  "/tmp/x/a.txt": { size: 1 },
};

export function contextFor(c: JudgeCase, extra: Partial<DecideContext> = {}): DecideContext {
  const entries: Record<string, FakeEntry> = {};
  for (const [k, v] of Object.entries({ ...BASE_FS, ...c.fs })) entries[expand(k)] = v;
  if (c.bulk) {
    for (let i = 0; i < c.bulk.count; i++)
      entries[`${expand(c.bulk.dir)}/f${i}.dat`] = { size: c.bulk.size };
  }
  return {
    home: HOME,
    cwd: CWD,
    fs: fakeFs(entries),
    session: { ...emptySession(), writtenFiles: c.written.map(expand) },
    agentPaths: [],
    ...extra,
  };
}

function expand(p: string): string {
  return p.startsWith("~/") ? HOME + p.slice(1) : p;
}

export function judgeCase(c: JudgeCase): PolicyDecision {
  return decide({ toolName: "Bash", input: { command: c.command } }, contextFor(c));
}

export function checkCase(c: JudgeCase, d: PolicyDecision): void {
  const e = c.expect;
  const why = `${c.id} ${c.command}\n→ ${JSON.stringify({ grade: d.grade, ruleIds: d.ruleIds, reasons: d.reasons })}`;
  if (e.grade !== undefined) expect(d.grade, why).toBe(e.grade);
  if (e.min_grade !== undefined)
    expect(gradeRank(d.grade), why).toBeGreaterThanOrEqual(gradeRank(e.min_grade));
  if (e.action) expect(d.action, why).toBe(e.action);
  for (const id of e.rule_ids_include ?? []) expect(d.ruleIds, why).toContain(id);
  for (const f of e.flags_include ?? []) expect(d.flags, why).toContain(f);
  if (e.rewrite_contains) expect(d.rewrite ?? "", why).toContain(e.rewrite_contains);
  if (e.file_count !== undefined) expect(d.preview?.fileCount, why).toBe(e.file_count);
}

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioFixture } from "./schema.ts";

/** ~/ 경로를 홈 기준 절대 경로로 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function fixturePaths(f: ScenarioFixture, home: string): string[] {
  const abs = expandHome(f.path, home);
  if (f.count === undefined) return [abs];
  return Array.from({ length: f.count }, (_, i) => abs.replaceAll("{n}", String(i + 1)));
}

/** 픽스처 파일을 만든다. 만든 절대 경로 목록을 돌려준다 */
export function writeFixtures(fixtures: ScenarioFixture[], home: string): string[] {
  const created: string[] = [];
  for (const f of fixtures) {
    for (const path of fixturePaths(f, home)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.content);
      created.push(path);
    }
  }
  return created;
}

/** 준비 명령은 에이전트가 아니라 실행기가 직접 돌린다 (VM 안에서만 호출됨) */
export function runBefore(commands: string[], home: string): void {
  for (const command of commands) {
    execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd: home,
      env: { ...process.env, HOME: home },
      stdio: "pipe",
    });
  }
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type Scenario, ScenarioSchema } from "./schema.ts";

export const SCENARIO_DIR = new URL("../scenarios/", import.meta.url).pathname;

/** 잘못된 시나리오 파일은 실행 전에 파일 이름과 함께 거부한다 */
export function parseScenario(text: string, file: string): Scenario {
  const result = ScenarioSchema.safeParse(parse(text));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`시나리오 형식 오류 (${file}): ${issues.join("; ")}`);
  }
  return result.data;
}

export async function loadScenarios(dir = SCENARIO_DIR): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const scenarios: Scenario[] = [];
  for (const f of files) scenarios.push(parseScenario(await readFile(join(dir, f), "utf8"), f));
  const ids = scenarios.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`시나리오 id 중복: ${dup}`);
  return scenarios;
}

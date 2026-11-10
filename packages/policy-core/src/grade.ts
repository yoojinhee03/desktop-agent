import type { Grade } from "./types.ts";

const RANK: Record<string, number> = { "0": 0, "1": 1, "2": 2, "3": 3, block: 4 };

export function gradeRank(g: Grade): number {
  return RANK[String(g)] ?? 4;
}

export function maxGrade(a: Grade, b: Grade): Grade {
  return gradeRank(a) >= gradeRank(b) ? a : b;
}

export function maxOf(grades: Grade[]): Grade {
  return grades.reduce<Grade>((acc, g) => maxGrade(acc, g), 0);
}

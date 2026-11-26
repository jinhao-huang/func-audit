import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Sample = { idx: number; func: string; commit_url?: string; target?: number };

export function parseSample(value: unknown): Sample {
  const sample = value as Partial<Sample> | null;
  if (!sample || !Number.isSafeInteger(sample.idx) || sample.idx! < 0) throw new Error("Expected a nonnegative integer sample ID.");
  if (typeof sample.func !== "string" || !sample.func.trim()) throw new Error(`Sample ${sample.idx} has no function text.`);
  if (sample.target !== undefined && sample.target !== 0 && sample.target !== 1) throw new Error("Expected a binary target.");
  if (sample.commit_url !== undefined && (typeof sample.commit_url !== "string" || !sample.commit_url.trim()
      || sample.target === undefined)) throw new Error("A repair commit requires a URL and a binary target.");
  return { idx: sample.idx!, func: sample.func, commit_url: sample.commit_url, target: sample.target };
}

export async function findSample(dir: string, idx: number) {
  const file = await readFile(join(dir, "test.jsonl"), "utf8");
  for (const row of file.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const sample = JSON.parse(row);
    if (sample.idx === idx) return parseSample(sample);
  }
  throw new Error(`Sample ${idx} was not found in test.jsonl.`);
}

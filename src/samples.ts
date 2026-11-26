import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const datasetPath = "data/raw/test.jsonl";
const manifestPath = "data/prepared/pairs.jsonl";

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

async function* datasetRows() {
  const text = await readFile(datasetPath, "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line.trim());
    } catch (cause) {
      throw new Error(`${datasetPath} line ${index + 1}: invalid JSON.`, { cause });
    }
  }
}

export async function preparePairs() {
  const pairs: number[][] = [];
  const seen = new Map<number, unknown>();
  let first: Sample | undefined;
  for await (const row of datasetRows()) {
    const sample = parseSample(row);
    if (sample.target === undefined) throw new Error(`Sample ${sample.idx} is missing its target.`);
    if (seen.has(sample.idx) && !isDeepStrictEqual(seen.get(sample.idx), row)) {
      throw new Error(`Conflicting records for sample ${sample.idx}.`);
    }
    seen.set(sample.idx, row);
    if (!first) {
      first = sample;
    } else {
      if (sample.target === first.target) throw new Error(`Pair ${pairs.length + 1} needs one sample of each target.`);
      pairs.push([first.idx, sample.idx]);
      first = undefined;
    }
  }
  if (first) throw new Error(`Sample ${first.idx} has no partner.`);
  if (!pairs.length) throw new Error(`${datasetPath} is empty.`);

  const dir = dirname(manifestPath);
  await mkdir(dir, { recursive: true });
  const temporary = await mkdtemp(join(dir, ".prepare-"));
  try {
    const path = join(temporary, "pairs.jsonl");
    await writeFile(path, pairs.map(pair => JSON.stringify(pair)).join("\n") + "\n");
    await rename(path, manifestPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return `Prepared ${pairs.length} pairs in ${manifestPath}.`;
}

export async function loadPair(pair: number): Promise<[Sample, Sample]> {
  const manifest = await readFile(manifestPath, "utf8").catch(error => {
    if (error.code === "ENOENT") throw new Error("Pair manifest missing. Run mise run prepare first.");
    throw error;
  });
  const line = manifest.trimEnd().split(/\r?\n/)[pair - 1];
  if (!line) throw new Error(`Pair ${pair} was not found in pairs.jsonl.`);
  const ids = JSON.parse(line);
  if (!Array.isArray(ids) || ids.length !== 2 || !ids.every(Number.isSafeInteger) || ids[0] === ids[1]) {
    throw new Error(`Invalid manifest entry for pair ${pair}. Run mise run prepare.`);
  }
  const records = new Map<number, Sample>();
  for await (const record of datasetRows()) {
    if (ids.includes(record.idx)) records.set(record.idx, parseSample(record));
    if (records.size === 2) break;
  }
  const first = records.get(ids[0]);
  const second = records.get(ids[1]);
  if (!first || !second || first.target == null || second.target == null || first.target === second.target) {
    throw new Error(`Pair ${pair} does not match the dataset. Run mise run prepare.`);
  }
  return [first, second];
}

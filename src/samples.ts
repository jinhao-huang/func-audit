import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const datasetPath = "data/raw/test.jsonl";
const rawKnowledge = "data/raw/knowledge.jsonl";
const prepared = "data/prepared";
const pairsPath = join(prepared, "pairs.jsonl");
export const knowledgePath = join(prepared, "knowledge.eval.jsonl");

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

function parsePair(value: unknown, pair: number): [Sample, Sample] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected two samples.");
  const [first, second] = value.map(parseSample);
  if (first.target === undefined || second.target === undefined || first.target === second.target) {
    throw new Error(`Pair ${pair} needs one sample of each target.`);
  }
  if (first.idx === second.idx) throw new Error(`Pair ${pair} needs two distinct sample IDs.`);
  return [first, second];
}

async function* rows(path: string) {
  await using file = await open(path);
  let number = 0;
  for await (const line of file.readLines()) {
    number++;
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error(`${path} line ${number}: invalid JSON.`, { cause });
    }
    yield { value, line };
  }
}

export async function prepareData() {
  const pairs: string[] = [];
  const seen = new Map<number, unknown>();
  const testCommits = new Set<string>();
  const pending: unknown[] = [];
  for await (const { value } of rows(datasetPath)) {
    pending.push(value);
    if (pending.length < 2) continue;
    const pair = parsePair(pending, pairs.length + 1);
    for (const [index, sample] of pair.entries()) {
      if (seen.has(sample.idx) && !isDeepStrictEqual(seen.get(sample.idx), pending[index])) {
        throw new Error(`Conflicting records for sample ${sample.idx}.`);
      }
      seen.set(sample.idx, pending[index]);
      if (sample.commit_url) testCommits.add(sample.commit_url);
    }
    pairs.push(JSON.stringify(pair));
    pending.length = 0;
  }
  if (pending.length) throw new Error(`The last record in ${datasetPath} has no partner.`);
  if (!pairs.length) throw new Error(`${datasetPath} is empty.`);

  await mkdir(prepared, { recursive: true });
  const temporary = await mkdtemp(join(prepared, ".prepare-"));
  let knowledgeSummary = `No ${rawKnowledge}; case retrieval disabled.`;
  try {
    const pairFile = join(temporary, "pairs.jsonl");
    await writeFile(pairFile, pairs.join("\n") + "\n");
    if (existsSync(rawKnowledge)) {
      let kept = 0;
      let excluded = 0;
      async function* evaluationRows() {
        for await (const { value, line } of rows(rawKnowledge)) {
          if (testCommits.has(value.commit_url)) {
            excluded++;
          } else {
            kept++;
            yield line + "\n";
          }
        }
      }
      const caseFile = join(temporary, "knowledge.eval.jsonl");
      await writeFile(caseFile, evaluationRows());
      await rename(caseFile, knowledgePath);
      knowledgeSummary = `Historical cases: ${kept} kept, ${excluded} excluded for overlap.`;
    } else {
      await rm(knowledgePath, { force: true });
    }
    await rename(pairFile, pairsPath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return `Prepared ${pairs.length} pairs in ${pairsPath}. ${knowledgeSummary}`;
}

export async function loadPair(pair: number) {
  const text = await readFile(pairsPath, "utf8").catch(error => {
    if (error.code === "ENOENT") throw new Error("Prepared pairs missing. Run mise run prepare first.");
    throw error;
  });
  const line = text.split("\n")[pair - 1];
  if (!line) throw new Error(`Pair ${pair} was not found in pairs.jsonl.`);
  try {
    return parsePair(JSON.parse(line), pair);
  } catch (cause) {
    throw new Error(`Invalid prepared pair ${pair}. Run mise run prepare.`, { cause });
  }
}

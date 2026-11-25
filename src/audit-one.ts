import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { reviewFunction } from "./review.ts";

const usage = "Usage: pnpm audit:one --dataset-dir <directory> --idx <sample-id>";

export async function auditOne(args: string[]) {
  // The OpenAI client merges OPENAI_* settings into requests, even with an explicit key.
  // Clear them in this CLI process before creating the project session.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPENAI_")) delete process.env[name];
  }
  const { values } = parseArgs({
    args,
    options: {
      "dataset-dir": { type: "string" },
      idx: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const dir = values["dataset-dir"];
  if (!dir || !values.idx || !/^\d+$/.test(values.idx)) throw new Error(usage);
  const idx = Number(values.idx);
  const file = await readFile(join(dir, "test.jsonl"), "utf8");
  for (const row of file.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const sample = JSON.parse(row);
    if (sample.idx !== idx) continue;
    if (typeof sample.func !== "string" || !sample.func.trim()) {
      throw new Error(`Sample ${idx} has no function text.`);
    }
    const report = await reviewFunction(sample.func);
    console.log(JSON.stringify({ idx, ...report }, null, 2));
    return;
  }
  throw new Error(`Sample ${idx} was not found in test.jsonl.`);
}

if (import.meta.main) {
  try {
    await auditOne(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

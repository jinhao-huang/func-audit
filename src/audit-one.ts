import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configuredModelId } from "./project-api.ts";
import { completeReport, failReport, saveContext, startReport, type SourceContext } from "./reports.ts";
import { prepareSnapshot } from "./snapshot.ts";
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
    const id = startReport(idx, sample.func, configuredModelId());
    if (process.stderr.isTTY) console.error(`Started report ${id}`);
    let report;
    let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
    let context: SourceContext | undefined;
    try {
      if (sample.commit_url !== undefined) {
        snapshot = await prepareSnapshot(sample.commit_url, sample.target, sample.func);
        const trace: SourceContext = { snapshot: snapshot.metadata, lookups: [] };
        context = trace;
        saveContext(id, trace);
        report = await reviewFunction(sample.func, {
          root: snapshot.root,
          location: snapshot.metadata,
          onLookups(lookups) {
            trace.lookups = lookups;
            saveContext(id, trace);
          },
        });
      } else {
        report = await reviewFunction(sample.func);
      }
      completeReport(id, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = `Report ${id} failed: ${message}`;
      try {
        failReport(id, message);
      } catch (saveError) {
        throw new Error(`${diagnostic} (could not save failure: ${String(saveError)})`, { cause: error });
      }
      throw new Error(diagnostic, { cause: error });
    } finally {
      await snapshot?.dispose();
    }
    console.log(JSON.stringify({ id, idx, ...report, ...(context ? { context } : {}) }, null, 2));
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

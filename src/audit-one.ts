import { parseArgs } from "node:util";
import { runAudit } from "./audit.ts";
import { configuredModelId } from "./project-api.ts";
import { readReport, startReport } from "./reports.ts";
import { findSample } from "./samples.ts";

const usage = "Usage: pnpm audit:one --dataset-dir <directory> --idx <sample-id>";

export async function auditOne(args: string[]) {
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
  const sample = await findSample(dir, idx);
  const id = startReport(idx, sample.func, configuredModelId(), sample.target);
  if (process.stderr.isTTY) console.error(`Started report ${id}`);
  await runAudit(id, sample, dir);
  const { model, prediction, reason, evidence, context } = readReport(id);
  console.log(JSON.stringify({ id, idx, model, prediction, reason, evidence, context }, null, 2));
}

if (import.meta.main) {
  try {
    await auditOne(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

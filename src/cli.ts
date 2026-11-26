import { parseArgs } from "node:util";
import { getSavedRun, predictions, readReport, score } from "./reports.ts";
import { loadPairs, prepareData } from "./samples.ts";
import { refreshQueue, submitRun } from "./queue.ts";
import { initializeReports } from "./database.ts";

const usage = {
  prepare: "mise run prepare",
  audit: "mise run audit PAIR_SELECTION (e.g. 1, 1-10,15 or all)",
  report: "mise run report RUN_ID",
  export: "mise run export RUN_ID",
  score: "mise run score RUN_ID",
};

async function main() {
  const command = process.argv[2] as keyof typeof usage;
  const { positionals, values } = parseArgs({
    args: process.argv.slice(3), allowPositionals: true, options: { help: { type: "boolean", short: "h" } },
  });
  if (!Object.hasOwn(usage, command)) throw new Error("Choose prepare, audit, report, export or score.");
  if (values.help) return console.log(`Usage: ${usage[command]}`);
  if (command === "prepare") {
    if (positionals.length) throw new Error(`Usage: ${usage.prepare}`);
    return console.log(await prepareData());
  }
  if (command === "audit") {
    if (positionals.length !== 1) throw new Error(`Usage: ${usage.audit}`);
    const { id, reports, pairs } = submitRun(await loadPairs(positionals[0]));
    return console.log(JSON.stringify({ id, pairs, reports }));
  }
  const id = Number(positionals[0]);
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0]) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Usage: ${usage[command]}`);
  }
  initializeReports();
  refreshQueue();
  const run = getSavedRun(id);
  if (!run) throw new Error(`Run ${id} was not found.`);
  if (command === "score") return console.log(JSON.stringify(score(run), null, 2));
  if (command === "export") return process.stdout.write(predictions(run));
  console.log(JSON.stringify({ ...run, reports: run.reports.map(report => readReport(report.id)) }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

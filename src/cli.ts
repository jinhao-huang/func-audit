import { parseArgs } from "node:util";
import { listRuns, predictions, readReport, recoverWorkers, score, startRun } from "./reports.ts";
import { loadPair, prepareData } from "./samples.ts";

const usage = {
  prepare: "mise run prepare",
  audit: "mise run audit PAIR_NUMBER",
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
  const id = Number(positionals[0]);
  if (positionals.length !== 1 || !/^\d+$/.test(positionals[0]) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Usage: ${usage[command]}`);
  }
  if (command === "audit") {
    const samples = await loadPair(id);
    const { runAudit } = await import("./audit.ts");
    const { configuredModelId } = await import("./project-api.ts");
    const run = startRun(id, samples, configuredModelId());
    if (process.stderr.isTTY) console.error(`Started run ${run.id}`);
    const results = await Promise.allSettled(run.jobs.map(job => runAudit(job.id, job.sample)));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`Run ${run.id}: ${failures.map(result => result.reason.message).join("\n")}`);
    return console.log(JSON.stringify(listRuns(run.id)[0], null, 2));
  }
  let [run] = listRuns(id);
  if (!run) throw new Error(`Run ${id} was not found.`);
  if (run.reports.some(report => report.status === "started")) {
    recoverWorkers();
    [run] = listRuns(id);
  }
  if (command === "score") return console.log(score(run));
  if (command === "export") return process.stdout.write(predictions(run));
  console.log(JSON.stringify({ ...run, reports: run.reports.map(report => readReport(report.id)) }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

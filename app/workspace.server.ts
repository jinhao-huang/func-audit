import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { configuredModelId } from "../src/project-api.ts";
import { failReport, initializeReports, recoverWorkers, listRuns, reportDetail, startRun } from "../src/reports.ts";
import type { Sample } from "../src/samples.ts";

let initialized = false;

export function openWorkspace() {
  if (!initialized) {
    initializeReports();
    initialized = true;
  }
  recoverWorkers();
}

export function routeId(value: string) {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) throw new Response("Invalid ID.", { status: 404 });
  return id;
}

export function getReport(value: string) {
  openWorkspace();
  const detail = reportDetail(routeId(value));
  if (!detail) throw new Response("Report not found.", { status: 404 });
  return detail;
}

export function getRun(value: string) {
  openWorkspace();
  const [run] = listRuns(routeId(value));
  if (!run) throw new Response("Run not found.", { status: 404 });
  return run;
}

export function submitRun(pair: number | null, samples: Sample[]) {
  const run = startRun(pair, samples, configuredModelId());
  for (const { id, sample } of run.jobs) {
    try {
      const worker = new Worker(resolve("src/audit-worker.ts"), {
        workerData: { id, sample }, execArgv: [],
      });
      worker.on("error", error => failReport(id, String(error)));
      worker.on("exit", () => failReport(id, "The audit worker stopped before saving a result."));
    } catch (error) {
      failReport(id, String(error));
    }
  }
  return run;
}

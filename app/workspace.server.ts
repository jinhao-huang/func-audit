import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { configuredModelId } from "../src/project-api.ts";
import { failReport, initializeReports, recoverWorkers, reportDetail, startReport } from "../src/reports.ts";
import type { Sample } from "../src/samples.ts";

let initialized = false;

export function openWorkspace() {
  if (!initialized) {
    initializeReports();
    initialized = true;
  }
  recoverWorkers();
}

export function reportId(value: string) {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id < 1) throw new Response("Report not found.", { status: 404 });
  return id;
}

export function getReport(value: string) {
  openWorkspace();
  const detail = reportDetail(reportId(value));
  if (!detail) throw new Response("Report not found.", { status: 404 });
  return detail;
}

export function submitAudit(sample: Sample) {
  openWorkspace();
  const id = startReport(sample.idx, sample.func, configuredModelId(), sample.target);
  try {
    const worker = new Worker(resolve("src/audit-worker.ts"), {
      workerData: { id, sample, dir: "data" }, execArgv: [],
    });
    worker.on("error", error => failReport(id, String(error)));
    worker.on("exit", () => failReport(id, "The audit worker stopped before saving a result."));
  } catch (error) {
    failReport(id, String(error));
  }
  return id;
}

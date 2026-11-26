import { initializeReports } from "../src/database.ts";
import { refreshQueue } from "../src/queue.ts";
import { getSavedRun, reportDetail } from "../src/reports.ts";

let initialized = false;

export function openWorkspace() {
  if (!initialized) {
    try {
      initializeReports();
    } catch (error) {
      throw new Response((error as Error).message, { status: 503 });
    }
    initialized = true;
  }
  return refreshQueue();
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
  const run = getSavedRun(routeId(value));
  if (!run) throw new Response("Run not found.", { status: 404 });
  return run;
}

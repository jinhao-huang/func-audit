import { initializeReports, openDatabase } from "../src/database.ts";
import { refreshQueue } from "../src/queue.ts";
import { getSavedRun, reportDetail } from "../src/reports.ts";
import { coversCitation } from "../src/evidence.ts";

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

export async function cancelAudit(request: Request, scope: "report" | "run", value: string) {
  const id = routeId(value);
  if (request.method !== "POST") throw new Response("Use POST to cancel.", { status: 405 });
  if ((await request.formData()).get("intent") !== "cancel") throw new Response("Unknown action.", { status: 400 });
  using db = openDatabase();
  const column = scope === "run" ? "runId" : "id";
  db.prepare(`UPDATE reports SET status = 'canceled' WHERE ${column} = ? AND status IN ('queued','running')`).run(id);
  return null;
}

export function getReport(value: string) {
  openWorkspace();
  const detail = reportDetail(routeId(value));
  if (!detail) throw new Response("Report not found.", { status: 404 });
  const { report, entries } = detail;
  const evidence = report.evidence?.map(item => {
    const match = entries.find(({ event }) => event.kind === "lookup" && coversCitation(event.lookup, item))?.event;
    return { ...item, callId: match?.kind === "lookup" ? match.callId : undefined };
  });
  return { report: { ...report, evidence }, entries };
}

export function getRun(value: string) {
  openWorkspace();
  const run = getSavedRun(routeId(value));
  if (!run) throw new Response("Run not found.", { status: 404 });
  return run;
}

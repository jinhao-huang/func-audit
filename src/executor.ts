import { setTimeout as delay } from "node:timers/promises";
import { type MessagePort, Worker } from "node:worker_threads";
import { type CaseQuery, searchCases } from "./cases.ts";
import { openDatabase } from "./database.ts";
import { failReport } from "./reports.ts";
import { configuredEndpoint } from "./project-api.ts";
import { caseIndexPath, type Sample } from "./samples.ts";

type Job = { id: number; idx: number; source: string; target: number | null; commitUrl: string | null; model: string; endpoint: string };

async function execute(job: Job) {
  try {
    if (job.endpoint !== configuredEndpoint()) throw new Error("The project API endpoint changed before this report could start.");
    const sample: Sample = { idx: job.idx, func: job.source, target: job.target ?? undefined, commit_url: job.commitUrl ?? undefined };
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./audit-worker.ts", import.meta.url), {
        workerData: { id: job.id, sample }, env: { ...process.env, FUNC_AUDIT_MODEL: job.model }, execArgv: [],
      });
      // Keep the native inference session on one thread, shared by all audit workers.
      worker.on("message", async ({ request, reply }: { request: CaseQuery; reply: MessagePort }) => {
        try {
          reply.postMessage(await searchCases(caseIndexPath, request));
        } catch (cause) {
          reply.postMessage({ error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          reply.close();
        }
      });
      worker.on("error", reject);
      worker.on("exit", code => code === 0 ? resolve() : reject(new Error(`Worker exited with status ${code}.`)));
    });
  } catch (error) {
    failReport(job.id, error instanceof Error ? error.message : String(error));
  }
}

using db = openDatabase();
const active = new Set<Promise<void>>();
while (true) {
  db.exec("BEGIN IMMEDIATE");
  const owner = db.prepare("SELECT capacity FROM executor WHERE pid = ?").get(process.pid);
  if (!owner) {
    db.exec("COMMIT");
    break;
  }
  const jobs = db.prepare(`
    SELECT r.id, idx, source, target, commitUrl, model, runs.endpoint FROM reports r
    JOIN runs ON r.runId = runs.id WHERE status = 'queued' ORDER BY r.id LIMIT ?
  `).all(Number(owner.capacity) - active.size) as Job[];
  for (const job of jobs) db.prepare("UPDATE reports SET status = 'running' WHERE id = ?").run(job.id);
  const idle = !jobs.length && !active.size;
  if (idle) db.exec("DELETE FROM executor");
  db.exec("COMMIT");
  if (idle) break;
  for (const job of jobs) {
    const task = execute(job).finally(() => active.delete(task));
    active.add(task);
  }
  // Check for new submissions even if the only active job is still waiting on the model.
  if (active.size < Number(owner.capacity)) {
    await delay(250);
  } else {
    await Promise.race(active);
  }
}

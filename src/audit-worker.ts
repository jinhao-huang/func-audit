import { workerData } from "node:worker_threads";
import { runAudit } from "./audit.ts";
import { openDatabase } from "./database.ts";

const { id, sample } = workerData;
using db = openDatabase(true);
const state = db.prepare("SELECT status FROM reports WHERE id = ?");
const controller = new AbortController();
function checkCancellation() {
  if (state.get(id)?.status === "canceled") controller.abort();
}
checkCancellation();
if (!controller.signal.aborted) {
  const timer = setInterval(checkCancellation, 500);
  try {
    await runAudit(id, sample, controller.signal);
  } finally {
    clearInterval(timer);
  }
}

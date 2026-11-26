import { once } from "node:events";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
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
    await runAudit(id, sample, async request => {
      const { port1, port2 } = new MessageChannel();
      try {
        parentPort!.postMessage({ request, reply: port2 }, [port2]);
        const [result] = await once(port1, "message", { signal: controller.signal });
        if ("error" in result) throw new Error(result.error);
        return result;
      } finally {
        port1.close();
      }
    }, controller.signal);
  } finally {
    clearInterval(timer);
  }
}

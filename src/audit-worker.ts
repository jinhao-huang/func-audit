import { once } from "node:events";
import { MessageChannel, parentPort, workerData } from "node:worker_threads";
import { runAudit } from "./audit.ts";

const { id, sample } = workerData;
await runAudit(id, sample, async request => {
  const { port1, port2 } = new MessageChannel();
  try {
    parentPort!.postMessage({ request, reply: port2 }, [port2]);
    const [result] = await once(port1, "message");
    if ("error" in result) throw new Error(result.error);
    return result;
  } finally {
    port1.close();
  }
});

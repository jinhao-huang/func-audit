import { workerData } from "node:worker_threads";
import { runAudit } from "./audit.ts";

const { id, sample } = workerData;
await runAudit(id, sample);

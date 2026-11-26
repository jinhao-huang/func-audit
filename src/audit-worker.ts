import { workerData } from "node:worker_threads";
import { runAudit } from "./audit.ts";

const { id, sample, dir } = workerData;
await runAudit(id, sample, dir);

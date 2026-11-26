import { runAudit } from "../src/audit.ts";
import { configuredModelId } from "../src/project-api.ts";
import { readReport, startRun } from "../src/reports.ts";

export async function reviewSample(sample) {
  const { jobs: [job] } = startRun(null, [sample], configuredModelId());
  await runAudit(job.id, sample);
  return readReport(job.id);
}

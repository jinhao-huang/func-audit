import { getReport } from "../workspace.server";
import type { Route } from "./+types/result";

export function loader({ params }: Route.LoaderArgs) {
  const { report } = getReport(params.id);
  if (report.status !== "completed") throw new Response("This report has no completed verdict.", { status: 409 });
  return new Response(JSON.stringify({ idx: report.idx, prediction: report.prediction }) + "\n", {
    headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="result.jsonl"' },
  });
}

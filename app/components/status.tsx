import { Badge } from "./ui/badge";
import type { Summary } from "../../src/reports.ts";

export function Status({ report }: { report: Pick<Summary, "status" | "target" | "prediction"> }) {
  if (report.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (report.status === "queued") return <Badge variant="outline">Queued</Badge>;
  if (report.status === "running") return <Badge variant="secondary">Running</Badge>;
  if (report.target == null) return <Badge variant="outline">Ungraded</Badge>;
  if (report.prediction === report.target) return <Badge className="bg-teal-100 text-teal-950">Correct</Badge>;
  return <Badge className="bg-amber-100 text-amber-950">{report.prediction === 1 ? "False positive" : "False negative"}</Badge>;
}

export function startedAt(iso: string) {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

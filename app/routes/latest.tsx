import { redirect } from "react-router";
import { listRuns } from "../../src/reports.ts";
import { openWorkspace } from "../workspace.server";

export function loader() {
  openWorkspace();
  const [latest] = listRuns();
  if (latest) throw redirect(!latest.pairs ? `/reports/${latest.firstReport}` : `/runs/${latest.id}`);
  return null;
}

export default function EmptyWorkspace() {
  return <><h1>No audits yet</h1><p className="hint mt-2">Choose New audit to review your first pair.</p></>;
}

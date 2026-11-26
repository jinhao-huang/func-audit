import { predictions } from "../../src/reports.ts";
import { getRun } from "../workspace.server";
import type { Route } from "./+types/result";

export function loader({ params }: Route.LoaderArgs) {
  const run = getRun(params.id);
  try {
    return new Response(predictions(run), { headers: {
      "Content-Type": "application/x-ndjson", "Content-Disposition": 'attachment; filename="result.jsonl"',
    } });
  } catch (error) {
    throw new Response((error as Error).message, { status: 409 });
  }
}

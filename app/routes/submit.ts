import { data, redirect } from "react-router";
import { loadPairs, parseSample } from "../../src/samples.ts";
import { submitRun } from "../../src/queue.ts";
import type { Route } from "./+types/submit";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const mode = form.has("sample") ? "sample" : "pair";
  try {
    const input = mode === "sample" ? parseSample(JSON.parse(String(form.get("sample")))) : await loadPairs(String(form.get("pair") ?? ""));
    const run = submitRun(input);
    return redirect(run.pairs ? `/runs/${run.id}` : `/reports/${run.firstReport}`, 303);
  } catch (error) {
    return data({ mode, error: (error as Error).message }, { status: 400 });
  }
}

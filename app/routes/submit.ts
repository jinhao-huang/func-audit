import { data, redirect } from "react-router";
import { findSample, parseSample } from "../../src/samples.ts";
import { submitAudit } from "../workspace.server";
import type { Route } from "./+types/submit";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const idx = String(form.get("idx") ?? "").trim();
  const json = String(form.get("sample") ?? "").trim();
  let sample;
  try {
    if (json && idx) throw new Error("Enter either a dataset ID or a JSON sample.");
    if (json) sample = parseSample(JSON.parse(json));
    else {
      if (!/^\d+$/.test(idx) || !Number.isSafeInteger(Number(idx))) throw new Error("Enter a sample ID or paste a JSON sample.");
      sample = await findSample("data", Number(idx));
    }
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Place test.jsonl in the data directory, or paste a JSON sample." : (error as Error).message;
    return data({ error: message }, { status: 400 });
  }
  return redirect(`/reports/${submitAudit(sample)}`, 303);
}

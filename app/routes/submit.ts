import { data, redirect } from "react-router";
import { loadPair, parseSample } from "../../src/samples.ts";
import { submitRun } from "../workspace.server";
import type { Route } from "./+types/submit";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const mode = form.has("sample") ? "sample" : "pair";
  let pair: number | null = null;
  let samples;
  try {
    if (mode === "sample") {
      samples = [parseSample(JSON.parse(String(form.get("sample"))))];
    } else {
      const value = String(form.get("pair") ?? "").trim();
      pair = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(pair) || pair < 1) throw new Error("Enter a positive pair number.");
      samples = await loadPair(pair);
    }
  } catch (error) {
    return data({ mode, error: (error as Error).message }, { status: 400 });
  }
  const run = submitRun(pair, samples);
  return redirect(pair === null ? `/reports/${run.jobs[0].id}` : `/runs/${run.id}`, 303);
}

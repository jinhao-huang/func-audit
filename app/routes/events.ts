import { setTimeout as delay } from "node:timers/promises";
import { recoverWorkers, reportUpdates } from "../../src/reports.ts";
import { openWorkspace, reportId } from "../workspace.server";
import type { Route } from "./+types/events";

export function loader({ params, request }: Route.LoaderArgs) {
  openWorkspace();
  const id = reportId(params.id);
  const cursor = request.headers.get("Last-Event-ID") ?? new URL(request.url).searchParams.get("after") ?? "0";
  let after = Number(cursor);
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(after)) throw new Response("Invalid event cursor.", { status: 400 });
  let page = reportUpdates(id, after);
  if (!page) throw new Response("Report not found.", { status: 404 });
  const end = new AbortController();
  const signal = AbortSignal.any([request.signal, end.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!page) {
          await delay(500, undefined, { signal });
          recoverWorkers(id);
          page = reportUpdates(id, after);
        }
        if (!page) throw new Error("The report no longer exists.");
        for (const entry of page.entries) {
          controller.enqueue(encoder.encode(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`));
          after = entry.seq;
        }
        if (page.status !== "started") {
          controller.enqueue(encoder.encode(`event: finished\ndata: ${page.status}\n\n`));
          controller.close();
        } else {
          controller.enqueue(encoder.encode(": connected\n\n"));
        }
        page = null;
      } catch (error) {
        if (end.signal.aborted) return;
        if (signal.aborted) controller.close();
        else controller.error(error);
      }
    },
    cancel() { end.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
  } });
}

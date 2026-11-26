import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("/", "routes/home.tsx", [
    index("routes/latest.tsx"),
    route("runs/:id", "routes/run.tsx"),
    route("reports/:id", "routes/report.tsx"),
  ]),
  route("runs", "routes/submit.ts"),
  route("course-pairs", "routes/course-pairs.ts"),
  route("reports/:id/events", "routes/events.ts"),
  route("runs/:id/result.jsonl", "routes/result.ts"),
] satisfies RouteConfig;

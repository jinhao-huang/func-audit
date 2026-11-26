import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("/", "routes/home.tsx", [
    index("routes/latest.tsx"),
    route("reports/:id", "routes/report.tsx"),
  ]),
  route("audits", "routes/submit.ts"),
  route("reports/:id/events", "routes/events.ts"),
  route("reports/:id/result.jsonl", "routes/result.ts"),
] satisfies RouteConfig;

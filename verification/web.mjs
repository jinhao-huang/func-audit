import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("submit, disconnect, replay tool events and download a persisted verdict", { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-web-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const path of ["src", "build"]) await symlink(resolve(path), join(cwd, path));
  await mkdir(join(cwd, "data"));
  await writeFile(join(cwd, "data", "knowledge.eval.jsonl"), JSON.stringify({ func: "int one();", cve: "CVE-2020-1234" }));
  await writeFile(join(cwd, "data", "test.jsonl"), JSON.stringify({ idx: 11, func: "int two() { return 2; }", target: 0 }));
  // An exited owner leaves a durable running record, as after a server interruption.
  execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { startReport } from "./src/reports.ts"; startReport(10, "int zero();", "fixture");'], { cwd });
  // Old reports can only inherit a label from the same sample and function.
  const db = new DatabaseSync(join(cwd, ".func-audit.sqlite"));
  db.exec(`
    INSERT INTO reports (idx, source, model, startedAt, status, prediction)
    VALUES (11, 'int two() { return 2; }', 'fixture', '2026-01-01', 'completed', 1),
           (11, 'int unrelated();', 'fixture', '2026-01-01', 'completed', 0);
    ALTER TABLE reports DROP COLUMN target;
  `);
  db.close();
  const finish = Promise.withResolvers();
  const called = Promise.withResolvers();
  let requests = 0;
  const model = createServer(async (_req, res) => {
    const first = ++requests === 1;
    if (!first) {
      called.resolve();
      await finish.promise;
    }
    const delta = requests === 3 ? { content: "{}" } : first ? { tool_calls: [{ index: 0, id: "lookup", type: "function",
      function: { name: "search_cases", arguments: '{"query":"one"}' } }] } : {
      content: JSON.stringify({ prediction: 0, reason: "Returns one.", evidence: [{ startLine: 1, endLine: 1 }] }),
    };
    const chunk = { choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(() => { finish.resolve(); model.closeAllConnections(); model.close(); });

  const server = spawn(process.execPath, [resolve("node_modules/@react-router/serve/dist/cli.js"), "build/server/index.js"], {
    cwd, stdio: ["ignore", "pipe", "inherit"], env: {
      ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", FUNC_AUDIT_API_KEY: "fixture", FUNC_AUDIT_MODEL: "fixture",
      FUNC_AUDIT_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
    },
  });
  t.after(() => server.kill("SIGKILL"));
  const lines = createInterface({ input: server.stdout });
  const [startup] = await once(lines, "line");
  const base = startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base, startup);
  const submit = (body) => fetch(base + "/audits", { method: "POST", redirect: "manual",
    headers: { origin: base }, body: new URLSearchParams(body) });
  const interrupted = await (await fetch(base + "/reports/1")).text();
  assert.match(interrupted, /audit process stopped before saving a result/);
  assert.equal((await submit({ idx: "-1" })).status, 400);
  assert.equal((await fetch(base, { redirect: "manual" })).headers.get("location"), "/reports/3");
  assert.equal((await submit({ sample: JSON.stringify({ idx: 9, func: "int one();", target: 2 }) })).status, 400);
  const migrated = await (await fetch(base + "/reports/2")).text();
  assert.match(migrated, /False positive/);
  assert.match(migrated, /<dd>Benign<\/dd>/);
  assert.match(await (await fetch(base + "/reports/3")).text(), /<dd>Unlabeled<\/dd>/);
  const response = await submit({ sample: JSON.stringify({ idx: 9, func: "int one() { return 1; }", target: 1 }) });
  assert.equal(response.status, 303);
  const report = base + response.headers.get("location");
  assert.equal((await fetch(report + "/result.jsonl")).status, 409);
  const disconnect = new AbortController();
  const stream = await fetch(report + "/events", { signal: disconnect.signal });
  const first = new TextDecoder().decode((await stream.body.getReader().read()).value);
  const cursor = first.match(/^id: (\d+)/m)?.[1];
  assert.ok(cursor, first);
  disconnect.abort();
  await called.promise;
  const resumed = await fetch(report + "/events?after=0", { headers: { "Last-Event-ID": cursor } });
  finish.resolve();
  const replay = await resumed.text();
  const entries = replay.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  assert.ok(entries.every(entry => entry.seq > Number(cursor)));
  assert.ok(entries.some(({ event }) => event.kind === "cases" && event.search.hits[0].cve === "CVE-2020-1234"));
  assert.match(replay, /event: finished\ndata: completed/);
  const html = await (await fetch(report)).text();
  assert.match(html, /Returns one\./);
  assert.match(html, /False negative/);
  assert.match(html, /aria-label="Report sections"/);
  assert.equal(await (await fetch(report + "/result.jsonl")).text(), '{"idx":9,"prediction":0}\n');
  assert.equal(requests, 2);
  const fromDataset = await submit({ idx: "11" });
  assert.equal(fromDataset.status, 303);
  const failedReport = base + fromDataset.headers.get("location");
  assert.match(await (await fetch(failedReport + "/events")).text(), /event: finished\ndata: failed/);
  assert.match(await (await fetch(failedReport)).text(), /Expected a binary prediction/);

  const owner = spawn(process.execPath, ["--input-type=module", "-e",
    'import { startReport } from "./src/reports.ts"; console.log(startReport(12, "int three();", "fixture")); process.stdin.resume();'],
    { cwd, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => owner.kill());
  const [id] = await once(createInterface({ input: owner.stdout }), "line");
  const live = await fetch(base + `/reports/${id}/events`, { signal: AbortSignal.timeout(5000) });
  owner.kill("SIGINT");
  assert.match(await live.text(), /event: finished\ndata: failed/);
  assert.match(await (await fetch(base + `/reports/${id}`)).text(), /audit process stopped before saving a result/);
});

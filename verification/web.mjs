import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("the development document loads its routes without modulepreload", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-dev-document-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const html = execFileSync(process.execPath, ["--conditions=development", "--input-type=module", "-e", `
    import { createRequestHandler } from "react-router";
    import * as build from "./build/server/index.js";
    process.chdir(process.argv[1]);
    const assets = { ...build.assets, hmr: { runtime: "/@vite/client" } };
    const handle = createRequestHandler({ ...build, assets }, "development");
    const response = await handle(new Request("http://localhost/"));
    process.stdout.write(await response.text());
  `, cwd], { encoding: "utf8" });
  assert.match(html, /New audit/);
  assert.match(html, /import "\/@vite\/client"/);
  assert.doesNotMatch(html, /rel="modulepreload"/);
});

test("CLI and workspace share one bounded queue, pair grades and interrupted-run recovery", { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-web-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const path of ["src", "build"]) await symlink(resolve(path), join(cwd, path));
  await mkdir(join(cwd, "data/raw"), { recursive: true });
  const samples = [{ idx: 9, func: "int one() { return 1; }", target: 1 },
    { idx: 11, func: "int two() { return 2; }", target: 0 }];
  await writeFile(join(cwd, "data/raw/test.jsonl"), [...samples, samples[0], { ...samples[1], idx: 12, func: "int three();" }].map(row => JSON.stringify(row)).join("\n"));
  await writeFile(join(cwd, "data/raw/knowledge.jsonl"), JSON.stringify({ func: "int one();", cve: "CVE-2020-1234" }));
  execFileSync(process.execPath, ["src/cli.ts", "prepare"], { cwd });
  await rm(join(cwd, "data/raw"), { recursive: true });
  let gate = Promise.withResolvers();
  const thirdReport = Promise.withResolvers();
  let atCapacity = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  let failThree = false;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks));
    const source = messages.find(message => message.role === "user").content[0].text;
    const one = source.includes("one()");
    const three = source.includes("three()");
    const lookup = one && !messages.some(message => message.role === "tool");
    active++;
    peak = Math.max(peak, active);
    res.once("close", () => active--);
    if (!lookup) {
      if (active === 2) atCapacity.resolve();
      await gate.promise;
      if (three) await thirdReport.promise;
    }
    const delta = lookup ? { tool_calls: [{ index: 0, id: "lookup", type: "function",
      function: { name: "search_cases", arguments: '{"query":"one"}' } }] } : {
      content: failThree && three ? "{}" : JSON.stringify({ prediction: Number(three), reason: "Returns a constant.", evidence: [{ startLine: 1, endLine: 1 }] }),
    };
    const chunk = { choices: [{ index: 0, delta, finish_reason: lookup ? "tool_calls" : "stop" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(() => { gate.resolve(); thirdReport.resolve(); model.closeAllConnections(); model.close(); });

  const env = {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", FUNC_AUDIT_CONCURRENCY: "2",
    FUNC_AUDIT_API_KEY: "fixture", FUNC_AUDIT_MODEL: "fixture", FUNC_AUDIT_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
  };
  const cliEnv = { ...env };
  const cli = (...args) => execFileSync(process.execPath, ["src/cli.ts", ...args], { cwd, env: cliEnv, encoding: "utf8" });
  const server = spawn(process.execPath, [resolve("node_modules/@react-router/serve/dist/cli.js"), "build/server/index.js"], {
    cwd, stdio: ["ignore", "pipe", "inherit"], env,
  });
  t.after(() => server.kill("SIGKILL"));
  const lines = createInterface({ input: server.stdout });
  const [startup] = await once(lines, "line");
  const base = startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(base, startup);
  const submit = (body) => fetch(base + "/runs", { method: "POST", redirect: "manual",
    headers: { origin: base }, body: new URLSearchParams(body) });
  assert.equal((await submit({ pair: "-1" })).status, 400);
  const missingPair = await submit({ pair: "1-3" });
  assert.equal(missingPair.status, 400);
  assert.equal((await missingPair.json()).mode, "pair");
  const invalidSample = await submit({ sample: JSON.stringify({ idx: 9, func: "int one();", target: 2 }) });
  assert.equal(invalidSample.status, 400);
  assert.equal((await invalidSample.json()).mode, "sample");
  const response = await submit({ pair: "1-2,1" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/runs/1");
  const run = base + "/runs/1";
  const report = base + "/reports/1";
  const db = new DatabaseSync(join(cwd, "data/results/runs.sqlite"), { readOnly: true, timeout: 5000 });
  t.after(() => db.close());
  const terminal = async id => (await fetch(base + `/reports/${id}/events`)).text();
  await atCapacity.promise;
  cliEnv.FUNC_AUDIT_CONCURRENCY = "4";
  assert.deepEqual(JSON.parse(cli("audit", "all")), { id: 2, pairs: 2, reports: 3 });
  cliEnv.FUNC_AUDIT_CONCURRENCY = "2";
  assert.equal(db.prepare("SELECT count(*) AS n FROM reports WHERE status='queued' AND runId=2").get().n, 3);
  assert.equal((await fetch(base, { redirect: "manual" })).headers.get("location"), "/runs/2");
  assert.match(await (await fetch(run)).text(), /0\/2 pairs scored/);
  assert.equal((await fetch(run + "/result.jsonl")).status, 409);
  const disconnect = new AbortController();
  const stream = await fetch(report + "/events", { signal: disconnect.signal });
  const first = new TextDecoder().decode((await stream.body.getReader().read()).value);
  const cursor = first.match(/^id: (\d+)/m)?.[1];
  assert.ok(cursor, first);
  disconnect.abort();
  const resumed = await fetch(report + "/events?after=0", { headers: { "Last-Event-ID": cursor } });
  gate.resolve();
  const replay = await resumed.text();
  const entries = replay.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  assert.ok(entries.every(entry => entry.seq > Number(cursor)));
  assert.ok(entries.some(({ event }) => event.kind === "cases" && event.search.hits[0].cve === "CVE-2020-1234"));
  assert.match(replay, /event: finished\ndata: completed/);
  await terminal(2);
  const inProgress = await (await fetch(run)).text();
  assert.match(inProgress, /2\/3 reports finished/);
  assert.match(inProgress, /1\/2 pairs scored · 0 failed · 1 awaiting results/);
  assert.deepEqual(JSON.parse(cli("score", "1")).pairs, [{ number: 1, grade: "P-B" }, { number: 2, grade: "pending" }]);
  thirdReport.resolve();
  await Promise.all([3, 4, 5, 6].map(terminal));
  assert.equal(peak, 2);
  const html = await (await fetch(report)).text();
  assert.match(html, /Returns a constant\./);
  assert.match(html, /False negative/);
  assert.match(html, /aria-label="Report sections"/);
  assert.match(await (await fetch(run)).text(), /2\/2 pairs scored/);
  assert.deepEqual(JSON.parse(cli("score", "2")).pairs, [{ number: 1, grade: "P-B" }, { number: 2, grade: "P-R" }]);
  const exported = await (await fetch(run + "/result.jsonl")).text();
  assert.equal(exported, '{"idx":9,"prediction":0}\n{"idx":11,"prediction":0}\n{"idx":12,"prediction":1}\n');
  assert.equal(cli("export", "2"), exported);

  failThree = true;
  assert.equal((await submit({ pair: "all" })).headers.get("location"), "/runs/3");
  await Promise.all([7, 8, 9].map(terminal));
  const partial = await (await fetch(base + "/runs/3")).text();
  assert.match(partial, /3\/3 reports finished/);
  assert.match(partial, /1\/2 pairs scored · 1 failed/);
  assert.match(await (await fetch(base + "/reports/9")).text(), /Expected a binary prediction/);
  assert.equal((await fetch(base + "/runs/3/result.jsonl")).status, 409);
  const solo = await submit({ sample: JSON.stringify(samples[0]) });
  assert.equal(solo.headers.get("location"), "/reports/10");
  assert.match(await terminal(10), /event: finished\ndata: completed/);
  assert.equal((await fetch(base + "/runs/4/result.jsonl")).status, 409);

  gate = Promise.withResolvers();
  atCapacity = Promise.withResolvers();
  failThree = false;
  assert.equal(JSON.parse(cli("audit", "all")).id, 5);
  await atCapacity.promise;
  process.kill(db.prepare("SELECT pid FROM executor").get().pid, "SIGKILL");
  gate.resolve();
  const results = await Promise.all([11, 12, 13].map(terminal));
  assert.match(results[0], /event: finished\ndata: failed/);
  assert.match(results[1], /event: finished\ndata: failed/);
  assert.match(results[2], /event: finished\ndata: completed/);
  assert.match(await (await fetch(base + "/reports/11")).text(), /audit process stopped before saving a result/);
});

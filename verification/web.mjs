import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

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

test("submit a pair, replay tool events, download both predictions and inspect a partial retry", { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-web-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const path of ["src", "build"]) await symlink(resolve(path), join(cwd, path));
  await mkdir(join(cwd, "data/raw"), { recursive: true });
  const samples = [{ idx: 9, func: "int one() { return 1; }", target: 1 },
    { idx: 11, func: "int two() { return 2; }", target: 0 }];
  await writeFile(join(cwd, "data/raw/test.jsonl"), samples.map(row => JSON.stringify(row)).join("\n"));
  await writeFile(join(cwd, "data/raw/knowledge.jsonl"), JSON.stringify({ func: "int one();", cve: "CVE-2020-1234" }));
  execFileSync(process.execPath, ["src/cli.ts", "prepare"], { cwd });
  await rm(join(cwd, "data/raw"), { recursive: true });
  execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { startRun } from "./src/reports.ts"; startRun(null, [{idx:10,func:"int zero();"}], "fixture");'], { cwd });
  const finish = Promise.withResolvers();
  const called = Promise.withResolvers();
  let failSecond = false;
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks));
    const one = messages.find(message => message.role === "user").content[0].text.includes("one()");
    const lookup = one && !messages.some(message => message.role === "tool");
    if (one && !lookup) {
      called.resolve();
      await finish.promise;
    }
    const delta = lookup ? { tool_calls: [{ index: 0, id: "lookup", type: "function",
      function: { name: "search_cases", arguments: '{"query":"one"}' } }] } : {
      content: !one && failSecond ? "{}" : JSON.stringify({ prediction: 0, reason: "Returns a constant.", evidence: [{ startLine: 1, endLine: 1 }] }),
    };
    const chunk = { choices: [{ index: 0, delta, finish_reason: lookup ? "tool_calls" : "stop" }] };
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
  const submit = (body) => fetch(base + "/runs", { method: "POST", redirect: "manual",
    headers: { origin: base }, body: new URLSearchParams(body) });
  const interrupted = await (await fetch(base + "/reports/1")).text();
  assert.match(interrupted, /rel="modulepreload"/);
  assert.match(interrupted, /audit process stopped before saving a result/);
  assert.equal((await submit({ pair: "-1" })).status, 400);
  const missingPair = await submit({ pair: "2" });
  assert.equal(missingPair.status, 400);
  assert.equal((await missingPair.json()).mode, "pair");
  const invalidSample = await submit({ sample: JSON.stringify({ idx: 9, func: "int one();", target: 2 }) });
  assert.equal(invalidSample.status, 400);
  assert.equal((await invalidSample.json()).mode, "sample");
  const response = await submit({ pair: "1" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/runs/2");
  const run = base + "/runs/2";
  const report = base + "/reports/2";
  assert.equal((await fetch(base, { redirect: "manual" })).headers.get("location"), "/runs/2");
  assert.match(await (await fetch(run)).text(), /Not scored/);
  assert.equal((await fetch(run + "/result.jsonl")).status, 409);
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
  assert.match(html, /Returns a constant\./);
  assert.match(html, /False negative/);
  assert.match(html, /aria-label="Report sections"/);
  await (await fetch(base + "/reports/3/events")).text();
  assert.match(await (await fetch(run)).text(), /P-B · Both predicted benign/);
  assert.equal(await (await fetch(run + "/result.jsonl")).text(), '{"idx":9,"prediction":0}\n{"idx":11,"prediction":0}\n');
  failSecond = true;
  assert.equal((await submit({ pair: "1" })).headers.get("location"), "/runs/3");
  await Promise.all([4, 5].map(async id => (await fetch(base + `/reports/${id}/events`)).text()));
  const partial = await (await fetch(base + "/runs/3")).text();
  assert.match(partial, /1 failed/);
  assert.match(partial, /Not scored/);
  assert.match(await (await fetch(base + "/reports/5")).text(), /Expected a binary prediction/);
  assert.equal((await fetch(base + "/runs/3/result.jsonl")).status, 409);
  const solo = await submit({ sample: JSON.stringify(samples[0]) });
  assert.equal(solo.headers.get("location"), "/reports/6");
  assert.match(await (await fetch(base + "/reports/6/events")).text(), /event: finished\ndata: completed/);
  assert.equal((await fetch(base + "/runs/4/result.jsonl")).status, 409);

  const owner = spawn(process.execPath, ["--input-type=module", "-e",
    'import { startRun } from "./src/reports.ts"; console.log(startRun(null, [{idx:12,func:"int three();"}], "fixture").jobs[0].id); process.stdin.resume();'],
    { cwd, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => owner.kill());
  const [id] = await once(createInterface({ input: owner.stdout }), "line");
  const live = await fetch(base + `/reports/${id}/events`, { signal: AbortSignal.timeout(5000) });
  owner.kill("SIGINT");
  assert.match(await live.text(), /event: finished\ndata: failed/);
  assert.match(await (await fetch(base + `/reports/${id}`)).text(), /audit process stopped before saving a result/);
});

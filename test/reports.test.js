import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { pairGrade } from "../src/reports.ts";

const exec = promisify(execFile);
const cli = resolve("src/cli.ts");

test("course grades follow the labels in either report order", () => {
  for (const [vulnerable, fixed, expected] of [[1, 0, "P-C"], [0, 1, "P-R"], [1, 1, "P-V"], [0, 0, "P-B"]]) {
    const reports = [{ target: 1, prediction: vulnerable, status: "completed" },
      { target: 0, prediction: fixed, status: "completed" }];
    assert.equal(pairGrade(...reports), expected);
    assert.equal(pairGrade(...reports.toReversed()), expected);
  }
});

test("prepare excludes test commits regardless of knowledge file order", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-prepare-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "data/raw"), { recursive: true });
  const samples = [0, 1].map(target => ({ idx: target, func: "int f();", target, commit_url: "repair" }));
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(cwd, "data/raw/test.jsonl"), jsonl(samples));
  const raw = join(cwd, "data/raw/knowledge.jsonl");
  const prepared = join(cwd, "data/prepared/knowledge.eval.jsonl");
  const keep = { commit_url: "other", cve: "shared" };
  const overlap = { commit_url: "repair", cve: "shared" };
  const prepare = () => exec(process.execPath, [cli, "prepare"], { cwd });
  for (const rows of [[keep, overlap, overlap], [overlap, overlap, keep]]) {
    await writeFile(raw, jsonl(rows));
    assert.match((await prepare()).stdout, /1 kept, 2 excluded for overlap/);
    assert.equal(await readFile(prepared, "utf8"), jsonl([keep]));
  }
  await writeFile(raw, jsonl([overlap]) + "{");
  await assert.rejects(prepare(), /knowledge.jsonl line 2: invalid JSON/);
  assert.equal(await readFile(prepared, "utf8"), jsonl([keep]));
  await rm(raw);
  assert.match((await prepare()).stdout, /case retrieval disabled/);
  await assert.rejects(readFile(prepared), { code: "ENOENT" });
});

test("prepare, audit, reopen and grade independent attempts at the same pair", { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-pairs-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "data/raw"), { recursive: true });
  const samples = [
    { idx: 30, target: 0, func: "int first(void) { return 0; }" },
    { idx: 10, target: 1, func: "int second(void) { return 1; }" },
  ];
  const dataset = join(cwd, "data/raw/test.jsonl");
  const prepare = () => exec(process.execPath, [cli, "prepare"], { cwd });
  await writeFile(dataset, JSON.stringify(samples[0]));
  await assert.rejects(prepare(), { code: 1 });
  const invalidPairs = [...samples, { ...samples[0], idx: 40 }, { ...samples[0], idx: 50 }];
  await writeFile(dataset, invalidPairs.map(sample => JSON.stringify(sample)).join("\n"));
  await assert.rejects(prepare(), /Pair 2 needs one sample of each target/);
  await writeFile(dataset, samples.map(sample => JSON.stringify(sample)).join("\n"));
  assert.match((await prepare()).stdout, /case retrieval disabled/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, "data/prepared/pairs.jsonl"), "utf8")), samples);
  await rm(dataset);

  await symlink(resolve("src"), join(cwd, "src"));
  let failSecond = false;
  const prompts = [];
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const prompt = body.messages.find(message => message.role === "user").content[0].text;
    prompts.push(prompt);
    const isSecond = prompt.includes("second");
    const verdict = { prediction: Number(isSecond), reason: "Reviewed the function.",
      evidence: [{ startLine: 1, endLine: failSecond && isSecond ? 2 : 1 }] };
    const chunk = { choices: [{ index: 0, delta: { content: JSON.stringify(verdict) }, finish_reason: "stop" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((ok, reject) => mock.once("error", reject).listen(0, "127.0.0.1", ok));
  t.after(() => mock.close());
  const env = { ...process.env, FUNC_AUDIT_API_KEY: "fixture", FUNC_AUDIT_MODEL: "fixture",
    FUNC_AUDIT_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` };
  const run = (...args) => exec(process.execPath, [cli, ...args], { cwd, env });
  await assert.rejects(run("audit", "2"), /Pair 2 was not found/);
  const receipts = await Promise.all([run("audit", "1"), run("audit", "all")]);
  const [first, second] = receipts.map(({ stdout }) => JSON.parse(stdout)).sort((a, b) => a.id - b.id);
  assert.deepEqual([first, second], [{ id: 1, pairs: 1, reports: 2 }, { id: 2, pairs: 1, reports: 2 }]);
  using db = new DatabaseSync(join(cwd, "data/results/runs.sqlite"));
  async function waitForRun(id) {
    while (db.prepare("SELECT 1 FROM reports WHERE runId=? AND status IN ('queued','running')").get(id)) await delay(40);
  }
  await Promise.all([waitForRun(first.id), waitForRun(second.id)]);
  assert.deepEqual(prompts.sort(), [...samples, ...samples].map(sample => `1 | ${sample.func}`).sort());
  assert.equal((await run("export", String(first.id))).stdout, '{"idx":30,"prediction":0}\n{"idx":10,"prediction":1}\n');
  failSecond = true;
  const { id } = JSON.parse((await run("audit", "all")).stdout);
  await waitForRun(id);
  assert.equal(JSON.parse((await run("score", String(id))).stdout).counts.failed, 1);
  await assert.rejects(run("export", String(id)), error => error.code === 1 && error.stdout === "");
  await assert.rejects(run("score", "1", "2"), /Usage:/);
  const retry = JSON.parse((await run("report", String(id))).stdout);
  assert.deepEqual(retry.reports.map(r => r.status), ["completed", "failed"]);
  assert.match(retry.reports[1].error, /Invalid source citation/);
  assert.equal(retry.reports[0].evidence[0].source, samples[0].func);
  assert.equal(JSON.parse((await run("score", String(first.id))).stdout).counts["P-C"], 1);
});

test("upgrade preserves historical run IDs, report links and pair grades", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-upgrade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "data/results"), { recursive: true });
  using db = new DatabaseSync(join(cwd, "data/results/runs.sqlite"));
  db.exec(`
    CREATE TABLE runs (id INTEGER PRIMARY KEY, pair INTEGER);
    CREATE TABLE reports (id INTEGER PRIMARY KEY, runId INTEGER, idx INTEGER, source TEXT, model TEXT,
      startedAt TEXT, status TEXT, target INTEGER, prediction INTEGER, reason TEXT, evidence TEXT, error TEXT);
    CREATE TABLE report_events (seq INTEGER PRIMARY KEY, reportId INTEGER, event TEXT);
    INSERT INTO runs VALUES (8, 17), (9, NULL);
    INSERT INTO reports VALUES
      (31, 8, 3, 'a', 'test', '', 'completed', 1, 1, 'a', '[]', NULL),
      (32, 8, 7, 'b', 'test', '', 'completed', 0, 0, 'b', '[]', NULL),
      (33, 9, 3, 'a', 'test', '', 'started', NULL, NULL, NULL, NULL, NULL);
  `);
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd })).stdout);
  db.prepare("INSERT INTO report_events(reportId, event) VALUES (32, ?)").run(JSON.stringify({ kind: "accepted", ownerPid: process.pid }));
  db.exec("UPDATE reports SET status = 'started', prediction = NULL WHERE id = 32");
  await assert.rejects(run("score", "8"), /previous version is still running/);
  const saved = db.prepare("UPDATE reports SET status = 'completed', prediction = 0 WHERE id = 32 AND status = 'started'").run();
  assert.equal(saved.changes, 1);
  assert.deepEqual((await run("score", "8")).pairs, [{ number: 17, grade: "P-C" }]);
  assert.deepEqual((await run("report", "8")).pairs, [{ number: 17, firstReport: 31, secondReport: 32 }]);
  const solo = await run("report", "9");
  assert.deepEqual(solo.pairs, []);
  assert.equal(solo.reports[0].id, 33);
  assert.equal(solo.reports[0].status, "failed");
});

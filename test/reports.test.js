import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { score } from "../src/reports.ts";

const exec = promisify(execFile);
const cli = resolve("src/cli.ts");

test("course grades follow the labels in either report order", () => {
  for (const [vulnerable, fixed, expected] of [[1, 0, "P-C"], [0, 1, "P-R"], [1, 1, "P-V"], [0, 0, "P-B"]]) {
    const reports = [{ target: 1, prediction: vulnerable, status: "completed" },
      { target: 0, prediction: fixed, status: "completed" }];
    assert.equal(score({ pair: 1, reports }), expected);
    assert.equal(score({ pair: 1, reports: reports.toReversed() }), expected);
  }
});

test("prepare, audit, reopen and grade independent attempts at the same pair", async t => {
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
  await writeFile(dataset, samples.map(sample => JSON.stringify(sample)).join("\n"));
  await prepare();
  assert.deepEqual(JSON.parse(await readFile(join(cwd, "data/prepared/pairs.jsonl"), "utf8")), [30, 10]);

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
  const first = JSON.parse((await run("audit", "1")).stdout);
  assert.deepEqual(prompts.sort(), samples.map(sample => `1 | ${sample.func}`).sort());
  assert.deepEqual(first.reports.map(r => r.idx), [30, 10]);
  assert.equal((await run("export", String(first.id))).stdout, '{"idx":30,"prediction":0}\n{"idx":10,"prediction":1}\n');
  failSecond = true;
  await assert.rejects(run("audit", "1"), /Run 2: Report 4 failed: Invalid source citation/);
  await assert.rejects(run("score", "2"), /needs two completed reports/);
  await assert.rejects(run("export", "2"), error => error.code === 1 && error.stdout === "");
  await assert.rejects(run("score", "1", "2"), /Usage:/);
  const retry = JSON.parse((await run("report", "2")).stdout);
  assert.deepEqual(retry.reports.map(r => r.status), ["completed", "failed"]);
  assert.equal(retry.reports[0].evidence[0].source, samples[0].func);
  const db = new DatabaseSync(join(cwd, "data/results/runs.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON reports
             BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  } finally {
    db.close();
  }
  await assert.rejects(run("audit", "1"), /Run 3:.*could not save failure: .*simulated write failure/);
  await rm(dataset);
  assert.equal((await run("score", String(first.id))).stdout.trim(), "P-C");
});

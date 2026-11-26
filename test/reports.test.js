import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const audit = fileURLToPath(new URL("../src/audit-one.ts", import.meta.url));
const show = fileURLToPath(new URL("../src/report-show.ts", import.meta.url));

test("each CLI attempt can be reopened after the audit process exits", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "func-audit-reports-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = "int identity(int value) {\n  return value;\n}";
  const dataset = join(cwd, "test.jsonl");
  await writeFile(dataset, JSON.stringify({ idx: 7, func: source }));

  const verdict = { prediction: 0, reason: "Returns the input.", evidence: [{ startLine: 2, endLine: 2 }] };
  let reply = JSON.stringify(verdict);
  const server = createServer((_req, res) => {
    const chunk = { choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = {
    ...process.env,
    FUNC_AUDIT_API_KEY: "test-key",
    FUNC_AUDIT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    FUNC_AUDIT_MODEL: "test-model",
  };
  const args = [audit, "--dataset-dir", cwd, "--idx", "7"];
  const success = await exec(process.execPath, args, { cwd, env });
  const output = JSON.parse(success.stdout);
  const successId = output.id;
  assert.ok(Number.isSafeInteger(successId) && successId > 0);
  assert.equal(success.stderr, "");

  reply = JSON.stringify({ ...verdict, evidence: [{ startLine: 4, endLine: 4 }] });
  let failedId;
  await assert.rejects(exec(process.execPath, args, { cwd, env }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    const diagnostic = /^Report (\d+) failed: Invalid source citation: 4–4\.$/.exec(error.stderr.trim());
    assert.ok(diagnostic, error.stderr);
    failedId = Number(diagnostic[1]);
    return true;
  });
  assert.notEqual(failedId, successId);

  // Allow the audit to start, then reject the write that would record its failure.
  const db = new DatabaseSync(join(cwd, ".func-audit.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON reports
             BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  } finally {
    db.close();
  }
  let unsavedId;
  await assert.rejects(exec(process.execPath, args, { cwd, env }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    const diagnostic = /^Report (\d+) failed: Invalid source citation: 4–4\./.exec(error.stderr);
    assert.ok(diagnostic, error.stderr);
    assert.match(error.stderr, /could not save failure: .*simulated write failure/);
    unsavedId = Number(diagnostic[1]);
    return true;
  });

  await rm(dataset);
  async function reopen(id) {
    const { stdout } = await exec(process.execPath, [show, "--id", String(id)], {
      cwd, env: { ...env, FUNC_AUDIT_API_KEY: "" },
    });
    return JSON.parse(stdout);
  }
  const expected = {
    id: successId, idx: 7, model: "openai-compatible/test-model", prediction: 0, reason: verdict.reason,
    evidence: [{ startLine: 2, endLine: 2, source: "  return value;" }],
  };
  assert.deepEqual(output, expected);
  const saved = await reopen(successId);
  assert.ok(Number.isFinite(Date.parse(saved.startedAt)));
  assert.deepEqual(saved, {
    ...expected, source, target: null, startedAt: saved.startedAt, status: "completed", error: null,
  });
  const failed = await reopen(failedId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.model, "test-model");
  assert.equal(failed.prediction, null);
  assert.equal(failed.evidence, null);
  assert.match(failed.error, /Invalid source citation/);
  assert.equal((await reopen(unsavedId)).status, "started");
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { auditOne } from "../src/audit-one.ts";
import { readReport } from "../src/reports.ts";
import { prepareSnapshot } from "../src/snapshot.ts";
import { sourceTools } from "../src/source-tools.ts";

test("case-distinct archive entries must survive extraction independently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "tree"));
  const func = "int identity(int x) { return x; }";
  await writeFile(join(dir, "tree/main.c"), func);
  await writeFile(join(dir, "tree/A.h"), "upper");
  const tar = promisify(execFile);
  await tar("tar", ["-cf", "fixture.tar", "tree"], { cwd: dir });
  await rename(join(dir, "tree/A.h"), join(dir, "tree/a.h"));
  await writeFile(join(dir, "tree/a.h"), "lower");
  await tar("tar", ["-rf", "fixture.tar", "tree/a.h"], { cwd: dir });
  const archive = gzipSync(await readFile(join(dir, "fixture.tar")));
  t.mock.method(globalThis, "fetch", async () => new Response(archive));
  const prepare = () => prepareSnapshot(`https://github.com/example/demo/commit/${"a".repeat(40)}`, 0, func);
  if (existsSync(join(dir, "TREE"))) {
    await assert.rejects(prepare(), /conflicting paths.*TMPDIR/);
  } else {
    const snapshot = await prepare();
    try {
      assert.equal(await readFile(join(snapshot.root, "A.h"), "utf8"), "upper");
      assert.equal(await readFile(join(snapshot.root, "a.h"), "utf8"), "lower");
    } finally {
      await snapshot.dispose();
    }
  }
});

test("snapshot grep searches across files and respects directory and file scope", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "func-audit-tools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "inc"));
  await writeFile(join(root, "inc", "answer.h"), "int answer(void);\n");
  await writeFile(join(root, "main.c"), "int main(void) { return answer(); }\n");
  await symlink(tmpdir(), join(root, "outside"));
  const log = [];
  const [grep, read] = sourceTools(root, (call) => log.push(call));
  const search = async (path) => (await grep.execute("g", { pattern: "answer", path })).content[0].text;
  assert.match(await search(), /main.c:1:/);
  assert.match(await search(), /inc\/answer.h:1:/);
  assert.equal(await search("inc/"), "inc/answer.h:1: int answer(void);");
  assert.equal(await search("inc/answer.h"), "inc/answer.h:1: int answer(void);");
  assert.equal((await grep.execute("g", { pattern: "absent" })).content[0].text, "No matches found.");
  for (const path of ["../", "/etc", "outside"]) {
    await assert.rejects(search(path), /snapshot/);
    await assert.rejects(read.execute("r", { path, startLine: 1, endLine: 1 }), /snapshot/);
  }
  assert.equal(log.at(-1).error, true);
});

test("Pi uses the selected snapshot and saved evidence survives its removal", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "func-audit-context-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  const func = "int identity(int value) {\n  return copy_value(value);\n}";
  await mkdir("archive/src", { recursive: true });
  await writeFile("archive/src/main.c", "\n" + func + "\n");
  await writeFile("archive/src/helper.c", "int copy_value(int x) {\n  return x;\n}\n");
  const { stdout: archive } = await promisify(execFile)("tar", ["-czf", "-", "archive"], { encoding: "buffer" });
  const commit = "a".repeat(40);
  const parent = "b".repeat(40);
  const link = `https://github.com/example/demo/commit/${commit}`;
  await writeFile("test.jsonl", JSON.stringify({ idx: 7, func, target: 1, commit_url: link }));
  t.mock.property(process, "env", {
    ...process.env, FUNC_AUDIT_API_KEY: "fixture", FUNC_AUDIT_BASE_URL: "https://model.invalid/v1",
    FUNC_AUDIT_MODEL: "fixture",
  });
  let requests = [];
  let rounds = 0;
  let grepResult;
  let citationEnd = 2;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(input, init);
    requests.push(req.url);
    if (req.url.startsWith("https://api.github.com/")) return Response.json({ parents: [{ sha: parent }] });
    if (req.url.startsWith("https://codeload.github.com/")) return new Response(archive);
    assert.equal(req.url, "https://model.invalid/v1/chat/completions");
    const body = await req.json();
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ["grep", "read"]);
    const messages = JSON.stringify(body.messages);
    for (const hidden of [link, commit, parent, "commit_url", dir]) assert.ok(!messages.includes(hidden));
    assert.match(messages, /src\/main.c/);
    const calls = [
      ["grep", { pattern: "copy_value" }],
      ["read", { path: "src/helper.c", startLine: 1, endLine: 2 }],
    ];
    const n = rounds++;
    if (n === 1) {
      grepResult = body.messages.findLast((message) => message.role === "tool").content;
      assert.match(grepResult, /src\/helper.c:1:/);
    }
    if (n === 2) assert.match(messages, /return x;/);
    const delta = n < 2 ? { tool_calls: [{ index: 0, id: "call" + n, type: "function",
      function: { name: calls[n][0], arguments: JSON.stringify(calls[n][1]) } }] } :
      { content: JSON.stringify({ prediction: 0, reason: "The helper returns its input.",
        evidence: [{ path: "src/helper.c", startLine: 2, endLine: citationEnd }] }) };
    const chunk = { choices: [{ index: 0, delta, finish_reason: n < 2 ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  let output;
  t.mock.method(console, "log", (json) => { output = JSON.parse(json); });
  const run = () => auditOne(["--dataset-dir", dir, "--idx", "7"]);
  await run();
  assert.equal(rounds, 3);
  assert.equal(requests[0], `https://api.github.com/repos/example/demo/git/commits/${commit}`);
  assert.equal(requests[1], `https://codeload.github.com/example/demo/tar.gz/${parent}`);
  const saved = readReport(output.id);
  assert.deepEqual(saved.context, output.context);
  assert.deepEqual(saved.context.snapshot, {
    repository: "example/demo", revision: parent, path: "src/main.c", startLine: 2, endLine: 4,
  });
  assert.equal(saved.context.lookups[1].result, "int copy_value(int x) {\n  return x;");
  assert.deepEqual(saved.evidence, [{ path: "src/helper.c", startLine: 2, endLine: 2, source: "  return x;" }]);

  await writeFile("test.jsonl", JSON.stringify({ idx: 7, func, target: 0, commit_url: link }));
  requests = [];
  rounds = 0;
  citationEnd = 3;
  await assert.rejects(run(), /must refer to lines returned by read/);
  assert.equal(requests[0], `https://codeload.github.com/example/demo/tar.gz/${commit}`);
  const failedLookups = readReport(output.id + 1).context.lookups;
  assert.deepEqual(failedLookups, [{ ...saved.context.lookups[0], result: grepResult }, saved.context.lookups[1]]);
  await assert.rejects(prepareSnapshot(link, 0, "int missing(void);"), /not found/);

  const db = new DatabaseSync(".func-audit.sqlite");
  try {
    db.exec(`CREATE TRIGGER reject_read BEFORE INSERT ON report_context
      WHEN json_extract(NEW.context, '$.lookups[#-1].tool') = 'read'
      BEGIN SELECT RAISE(ABORT, 'simulated trace failure'); END`);
  } finally {
    db.close();
  }
  rounds = 0;
  citationEnd = 2;
  await assert.rejects(run(), /Could not save snapshot lookup: simulated trace failure/);
  assert.equal(rounds, 2);
  const failed = readReport(output.id + 2);
  assert.equal(failed.status, "failed");
  assert.equal(failed.evidence, null);
  assert.deepEqual(failed.context.lookups, [{ ...saved.context.lookups[0], result: grepResult }]);
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { reviewSample } from "../verification/audit-fixture.mjs";
import { readReport, reportUpdates } from "../src/reports.ts";
import { prepareSnapshot } from "../src/snapshot.ts";
import { sourceTools } from "../src/source-tools.ts";

const exec = promisify(execFile);

async function repositoryFixture(t, dir) {
  const remote = join(dir, "upstream");
  await mkdir(remote);
  t.mock.property(process, "env", { ...process.env, XDG_CACHE_HOME: join(dir, "cache"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/example/demo.git", GIT_ALLOW_PROTOCOL: "file" });
  const git = async (...args) => (await exec("git", ["-C", remote, "-c", "user.name=Test",
    "-c", "user.email=test@example.invalid", ...args])).stdout.trim();
  await git("init", "-q");
  const commit = async () => {
    await git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { remote, git, commit };
}

test("canceling a fetch after receiving bytes releases the cache for a retry", { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { remote, git, commit } = await repositoryFixture(t, dir);
  const temp = join(dir, "snapshots");
  await mkdir(temp);
  process.env.TMPDIR = temp;
  const source = "int one() { return 1; }";
  await writeFile(join(remote, "main.c"), source);
  await git("add", "main.c");
  const link = `https://github.com/example/demo/commit/${await commit()}`;
  const controller = new AbortController();
  const progress = [];
  const work = prepareSnapshot(link, 0, source, event => {
    progress.push(event);
    if (event.kind === "download" && event.bytes > 0) controller.abort();
  }, controller.signal);
  await assert.rejects(work, { name: "AbortError" });
  assert.ok(progress.some(event => event.kind === "download" && event.bytes > 0));
  assert.deepEqual(await readdir(temp), []);
  const retry = await prepareSnapshot(link, 0, source);
  try {
    assert.equal(await readFile(join(retry.root, "main.c"), "utf8"), source);
  } finally { await retry.dispose(); }
});

test("case-distinct archive entries must survive extraction independently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-case-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { remote, git, commit } = await repositoryFixture(t, dir);
  const func = "int identity(int x) { return x; }";
  await writeFile(join(remote, "main.c"), func);
  await git("add", "main.c");
  for (const [name, text] of [["A.h", "upper"], ["a.h", "lower"]]) {
    await writeFile(join(remote, name), text);
    const blob = await git("hash-object", "-w", name);
    await git("-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
  }
  const link = `https://github.com/example/demo/commit/${await commit()}`;
  const prepare = () => prepareSnapshot(link, 0, func);
  if (existsSync(join(dir, "UPSTREAM"))) {
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

test("two workers share a cold fetch and reopen both revisions offline", async t => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-shared-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { remote, git, commit } = await repositoryFixture(t, dir);
  const file = "value.c";
  const sources = ["int value() { return 2; }", "int value() { return 1; }"];
  await writeFile(join(remote, file), sources[1]);
  await git("add", file);
  const parent = await commit();
  await writeFile(join(remote, file), sources[0]);
  await git("add", file);
  const repair = await commit();
  const link = `https://github.com/Example/Demo/commit/${repair}`;
  const trace = join(dir, "git.jsonl");
  const code = `
    import { parentPort, workerData } from "node:worker_threads";
    import { readFile } from "node:fs/promises";
    import { once } from "node:events";
    import { prepareSnapshot } from ${JSON.stringify(new URL("../src/snapshot.ts", import.meta.url).href)};
    parentPort.postMessage("ready");
    await once(parentPort, "message");
    const {link, target, source} = workerData;
    const snapshot = await prepareSnapshot(link, target, source);
    try {
      parentPort.postMessage({ revision: snapshot.metadata.revision, text: await readFile(snapshot.root + "/value.c", "utf8") });
    } finally { await snapshot.dispose(); }
  `;
  async function runPair() {
    const workers = sources.map((source, target) => new Worker(new URL("data:text/javascript," + encodeURIComponent(code)), {
      workerData: { link, target, source }, env: { ...process.env, GIT_TRACE2_EVENT: trace },
    }));
    await Promise.all(workers.map(worker => once(worker, "message")));
    const results = workers.map(worker => once(worker, "message"));
    for (const worker of workers) worker.postMessage("start");
    assert.deepEqual(await Promise.all(results), [
      [{ revision: repair, text: sources[0] }], [{ revision: parent, text: sources[1] }],
    ]);
  }
  await runPair();
  await rename(remote, remote + "-offline");
  await runPair();
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === "cmd_name" && event.name === "fetch").length, 1);
  assert.equal(events.filter(event => event.event === "cmd_name" && event.name === "upload-pack").length, 1);

  // The parent exists as a shallow boundary. Using it as a repair needs its own fetch.
  const parentLink = link.replace(repair, parent);
  await assert.rejects(prepareSnapshot(parentLink, 1, sources[1]), /fetch/);
  await rename(remote + "-offline", remote);
  await assert.rejects(prepareSnapshot(parentLink, 1, sources[1]), /one identifiable parent/);
  const original = await prepareSnapshot(parentLink, 0, sources[1]);
  await original.dispose();
});

test("snapshot grep searches across files and respects directory and file scope", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "func-audit-tools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "inc"));
  await writeFile(join(root, "inc", "answer.h"), "int answer(void);\n");
  await writeFile(join(root, "main.c"), "int main(void) { return answer(); }\n");
  await symlink(tmpdir(), join(root, "outside"));
  const log = [];
  await using source = sourceTools(root, (call) => log.push(call));
  const [grep, read] = source.tools;
  const search = async (path) => (await grep.execute("g", { pattern: "answer", path })).content[0].text;
  assert.match(await search(), /main.c:1:/);
  assert.match(await search(), /inc\/answer.h:1:/);
  assert.equal(await search("inc/"), "inc/answer.h:1:5: int answer(void);");
  assert.equal(await search("inc/answer.h"), "inc/answer.h:1:5: int answer(void);");
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
  const fixture = await repositoryFixture(t, dir);
  await mkdir(join(fixture.remote, "src"));
  await writeFile(join(fixture.remote, "src/main.c"), "\n" + func + "\n");
  await writeFile(join(fixture.remote, "src/helper.c"), "int copy_value(int x) {\n  return x;\n}\n");
  await fixture.git("add", "src");
  const parent = await fixture.commit();
  await writeFile(join(fixture.remote, "note"), "updated");
  await fixture.git("add", "note");
  const commit = await fixture.commit();
  const link = `https://github.com/example/demo/commit/${commit}`;
  const sample = { idx: 7, func, target: 1, commit_url: link };
  Object.assign(process.env, { FUNC_AUDIT_API_KEY: "fixture",
    FUNC_AUDIT_BASE_URL: "https://model.invalid/v1", FUNC_AUDIT_MODEL: "fixture" });
  let withCases = true;
  await mkdir("data/prepared", { recursive: true });
  await writeFile("data/prepared/cases.sqlite", "This index must stay unopened until Pi searches.");
  let rounds = 0;
  let grepResult;
  let citationEnd = 2;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.url, "https://model.invalid/v1/chat/completions");
    const body = await req.json();
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), withCases ? ["grep", "lsp", "read", "search_cases"] : ["grep", "lsp", "read"]);
    const messages = JSON.stringify(body.messages);
    for (const hidden of [link, commit, parent, "commit_url", dir]) assert.ok(!messages.includes(hidden));
    assert.match(messages, /src\/main.c/);
    const calls = [
      ["grep", { pattern: "copy_value" }],
      ["lsp", { operation: "hover", path: "src/helper.c", line: 1, column: 5 }],
      ["read", { path: "src/helper.c", startLine: 1, endLine: 2 }],
    ];
    const n = rounds++;
    if (n === 1) {
      grepResult = body.messages.findLast((message) => message.role === "tool").content;
      assert.match(grepResult, /src\/helper.c:1:/);
    }
    if (n === 2) assert.match(messages, /clangd hover/);
    if (n === 3) assert.match(messages, /return x;/);
    const delta = n < calls.length ? { tool_calls: [{ index: 0, id: "call" + n, type: "function",
      function: { name: calls[n][0], arguments: JSON.stringify(calls[n][1]) } }] } :
      { content: JSON.stringify({ prediction: 0, reason: "The helper returns its input.",
        evidence: [{ path: "src/helper.c", startLine: 2, endLine: citationEnd }] }) };
    const chunk = { choices: [{ index: 0, delta, finish_reason: n < calls.length ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const run = () => reviewSample(sample);
  const output = await run();
  const stages = reportUpdates(output.id, 0).entries.map(({ event }) => event);
  assert.deepEqual(stages.slice(0, 5).map(e => e.kind), ["prepare", "download", "extract", "locate", "review"]);
  assert.ok(stages[1].bytes > 0);
  assert.equal(rounds, 4);
  const saved = readReport(output.id);
  assert.deepEqual(saved.context, output.context);
  assert.deepEqual(saved.context.caseSearches, []);
  assert.deepEqual(saved.context.snapshot, {
    repository: "example/demo", revision: parent, path: "src/main.c", startLine: 2, endLine: 4,
  });
  assert.match(saved.context.lookups[1].result, /clangd hover/);
  assert.equal(saved.context.lookups[2].result, "int copy_value(int x) {\n  return x;");
  assert.deepEqual(saved.evidence, [{ path: "src/helper.c", startLine: 2, endLine: 2, source: "  return x;" }]);

  withCases = false;
  await rm("data/prepared/cases.sqlite");
  sample.target = 0;
  rounds = 0;
  citationEnd = 3;
  await assert.rejects(run(), /must refer to lines returned by read/);
  assert.ok(!reportUpdates(output.id + 1, 0).entries.some(({ event }) => event.kind === "download"));
  const failedLookups = readReport(output.id + 1).context.lookups;
  assert.deepEqual(failedLookups, [{ ...saved.context.lookups[0], result: grepResult }, ...saved.context.lookups.slice(1)]);
  await assert.rejects(prepareSnapshot(link, 0, "int missing(void);"), /not found/);

  const db = new DatabaseSync("data/results/runs.sqlite");
  try {
    db.exec(`CREATE TRIGGER reject_read BEFORE INSERT ON report_events
      WHEN json_extract(NEW.event, '$.lookup.tool') = 'read'
      BEGIN SELECT RAISE(ABORT, 'simulated trace failure'); END`);
  } finally {
    db.close();
  }
  rounds = 0;
  citationEnd = 2;
  await assert.rejects(run(), /Could not save snapshot lookup: simulated trace failure/);
  assert.equal(rounds, 3);
  const failed = readReport(output.id + 2);
  assert.equal(failed.status, "failed");
  assert.equal(failed.evidence, null);
  assert.deepEqual(failed.context.lookups, [{ ...saved.context.lookups[0], result: grepResult }, saved.context.lookups[1]]);
});

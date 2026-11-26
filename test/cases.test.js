import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchCases } from "../src/cases.ts";
import { auditOne } from "../src/audit-one.ts";
import { readReport } from "../src/reports.ts";

function historical(cve, commit, func = "int copy_item(void);") {
  return { idx: 7, func, cve, cwe: ["CWE-20"], cve_desc: "Validate the item length.",
    commit_id: commit, commit_message: "Check the supplied size." };
}

test("BM25 returns the best match per CVE and refreshes a changed corpus", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-cases-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "knowledge.eval.jsonl");
  const rows = [
    historical("one", "first"),
    historical("one", "second"),
    historical("two", "first"),
    historical("three", "third"),
    historical("one", "fourth", "int copy_item(void) { return rare_operation(); }"),
  ];
  await writeFile(file, "\n" + rows.map((row) => JSON.stringify(row)).join("\n"));
  const search = (query) => searchCases(file, query);
  assert.deepEqual(search("copy_item").hits.map((hit) => hit.line), [2, 4, 5]);
  assert.equal(search("rare_operation copy_item").hits[0].line, 6);
  assert.deepEqual(search('absent + "unmatched').hits, []);
  assert.equal(search("CWE-20").hits.length, 3);
  await writeFile(file, JSON.stringify(historical("new", "new", "void only_new(void);")));
  assert.deepEqual(search("copy_item").hits, []);
  assert.deepEqual(search("only_new").hits.map((hit) => hit.line), [1]);
});

test("Pi receives historical cases only through its own search", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "func-audit-case-review-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  const source = "int review(void) { return copy_item(); }";
  await writeFile("test.jsonl", JSON.stringify({ idx: 4, func: source }));
  await writeFile("knowledge.jsonl", JSON.stringify(historical("course-original", "other-repair")));
  await writeFile("knowledge.eval.jsonl", JSON.stringify(historical("example-case", "private-repair")));
  t.mock.property(process, "env", { ...process.env, FUNC_AUDIT_API_KEY: "fixture",
    FUNC_AUDIT_BASE_URL: "https://mock.invalid/v1", FUNC_AUDIT_MODEL: "fixture" });
  let search, output;
  t.mock.method(console, "log", (json) => { output = JSON.parse(json); });
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.url, "https://mock.invalid/v1/chat/completions");
    const { tools, messages } = await req.json();
    assert.deepEqual(tools.map((tool) => tool.function.name), ["search_cases"]);
    assert.ok(!JSON.stringify(messages).includes("private-repair"));
    const followup = messages.findLast((message) => message.role === "tool");
    let delta;
    if (!followup) {
      const prompt = messages.find((message) => message.role === "user").content[0].text;
      assert.equal(prompt, `1 | ${source}`);
      assert.ok(!JSON.stringify(messages).includes("example-case"));
      delta = { tool_calls: [{ index: 0, id: "search1", type: "function",
        function: { name: "search_cases", arguments: JSON.stringify({ query: "length" }) } }] };
    } else {
      search = JSON.parse(followup.content);
      assert.equal(search.query, "length");
      assert.deepEqual(search.hits.map((hit) => hit.cve), ["example-case"]);
      assert.equal(search.hits[0].line, 1);
      delta = { content: JSON.stringify({ prediction: 0, reason: "Returns the helper result.",
        evidence: [{ startLine: 1, endLine: 1 }] }) };
    }
    const chunk = { choices: [{ index: 0, delta, finish_reason: followup ? "stop" : "tool_calls" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  await auditOne(["--dataset-dir", dir, "--idx", "4"]);
  assert.deepEqual(output.context.caseSearches, [search]);
  await rm("knowledge.eval.jsonl");
  const saved = readReport(output.id);
  assert.deepEqual(saved.context, output.context);
  assert.equal(saved.evidence[0].source, source);

  await writeFile("knowledge.eval.jsonl", JSON.stringify({ func: "int item(void);" }));
  await assert.rejects(auditOne(["--dataset-dir", dir, "--idx", "4"]), /Expected a CVE identifier/);
  const failed = readReport(output.id + 1);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.context.caseSearches, [
    { query: "length", error: "knowledge.eval.jsonl line 1: Expected a CVE identifier." },
  ]);
});

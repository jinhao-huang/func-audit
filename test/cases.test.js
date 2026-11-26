import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildCaseIndex, searchCases } from "../src/cases.ts";
import { reviewSample } from "../verification/audit-fixture.mjs";
import { readReport } from "../src/reports.ts";

function historical(cve, commit, func = "int copy_item(void);") {
  return { idx: 7, func, cve, cwe: ["CWE-20"], cve_desc: "Validate the item length.",
    commit_id: commit, commit_message: "Check the supplied size." };
}

// Keep the model boundary offline while exercising the real SQLite index and rank fusion.
const encodings = [];
let queryModelLoads = 0;
mock.module("@huggingface/transformers", { exports: {
  pipeline: async (_task, _model, { local_files_only }) => {
    if (local_files_only) {
      queryModelLoads++;
    } else {
      assert.ok(!("HF_TOKEN" in process.env) && !("HF_ACCESS_TOKEN" in process.env));
    }
    const encoder = async texts => {
      encodings.push({ localOnly: local_files_only, texts });
      const data = new Float32Array(texts.length * 384);
      texts.forEach((text, i) => {
        const dimension = /lifetime|dangling/.test(text) ? 0 : 1;
        data[i * 384 + dimension] = 1;
      });
      return { data, dims: [texts.length, 384] };
    };
    encoder.dispose = async () => {};
    return encoder;
  },
} });

test("hybrid search fuses distinct CVEs and preserves the strongest lexical row", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "func-audit-cases-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "knowledge.eval.jsonl");
  const index = join(dir, "cases.sqlite");
  const special = historical("both", "fourth", "void rare_operation();");
  special.commit_message = "Background detail. ".repeat(60) + "Initialize the cache.";
  const rows = [
    { ...historical("semantic", "first"), cve_desc: "Object lifetime." },
    { ...historical("both", "second"), cve_desc: "Object lifetime." },
    { ...historical("lexical", "third", "void rare_operation();"), cve_desc: "" },
    { ...special, cve_desc: "Object lifetime." },
    historical("distant", "fifth"),
  ];
  await writeFile(file, "\n" + rows.map(row => JSON.stringify(row)).join("\n"));
  t.mock.property(process, "env", { ...process.env, HF_TOKEN: "fixture", HF_ACCESS_TOKEN: "fixture" });
  assert.equal(await buildCaseIndex(file, index), 3);
  assert.equal(encodings[0].localOnly, false);
  assert.deepEqual(encodings[0].texts.toSorted(), ["Object lifetime.", "Object lifetime.", "Validate the item length."]);
  using db = new DatabaseSync(index, { readOnly: true });
  assert.equal(db.prepare("SELECT sum(length(embedding)) AS bytes FROM vectors").get().bytes, 3 * 384 * 4);
  const search = async query => (await searchCases(index, query)).hits;
  const [hits, semanticHits] = await Promise.all([search("dangling rare_operation initialize"), search("dangling")]);
  assert.equal(queryModelLoads, 1);
  assert.deepEqual(hits.map(hit => hit.cve), ["both", "semantic", "lexical"]);
  assert.equal(hits[0].line, 5);
  assert.match(hits[0].commitMessage, /Initialize the cache\./);
  assert.ok(hits[0].commitMessage.length <= 800);
  assert.equal(hits[1].line, 2);
  assert.deepEqual(encodings.filter(call => call.localOnly).flatMap(call => call.texts).sort(), [
    "Represent this sentence for searching relevant passages: dangling",
    "Represent this sentence for searching relevant passages: dangling rare_operation initialize",
  ]);
  assert.deepEqual(semanticHits.map(hit => hit.cve), ["semantic", "both", "distant"]);
  assert.deepEqual(await search(' + "'), []);
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
  const sample = { idx: 4, func: source };
  await mkdir("data/raw", { recursive: true });
  await mkdir("data/prepared", { recursive: true });
  await writeFile("data/raw/knowledge.jsonl", JSON.stringify(historical("course-original", "other-repair")));
  await writeFile("data/prepared/knowledge.eval.jsonl", JSON.stringify(historical("example-case", "private-repair")));
  await buildCaseIndex("data/prepared/knowledge.eval.jsonl", "data/prepared/cases.sqlite");
  t.mock.property(process, "env", { ...process.env, FUNC_AUDIT_API_KEY: "fixture",
    FUNC_AUDIT_BASE_URL: "https://mock.invalid/v1", FUNC_AUDIT_MODEL: "fixture" });
  let search;
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
      assert.deepEqual(search.hits, [{ line: 1, cve: "example-case", cwe: "CWE-20",
        description: "Validate the item length.", commitMessage: "Check the supplied size.",
        excerpt: "int copy_item(void);" }]);
      delta = { content: JSON.stringify({ prediction: 0, reason: "Returns the helper result.",
        evidence: [{ startLine: 1, endLine: 1 }] }) };
    }
    const chunk = { choices: [{ index: 0, delta, finish_reason: followup ? "stop" : "tool_calls" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const output = await reviewSample(sample);
  assert.deepEqual(output.context.caseSearches, [search]);
  await rm("data/prepared/knowledge.eval.jsonl");
  const saved = readReport(output.id);
  assert.deepEqual(saved.context, output.context);
  assert.equal(saved.evidence[0].source, source);

  await writeFile("data/prepared/cases.sqlite", "broken index");
  await assert.rejects(reviewSample(sample), /file is not a database/);
  const failed = readReport(output.id + 1);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.context.caseSearches, [
    { query: "length", error: "file is not a database" },
  ]);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewSample } from "../verification/audit-fixture.mjs";

test("audits use the project key, endpoint and model", async (t) => {
  t.mock.property(process, "env", {
    ...process.env,
    DEEPSEEK_API_KEY: "personal-key",
    FUNC_AUDIT_API_KEY: "",
    FUNC_AUDIT_BASE_URL: "",
    FUNC_AUDIT_MODEL: "",
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    const { model } = await request.json();
    requests.push([request.url, request.headers.get("authorization"), model]);
    for (const name of ["x-personal", "openai-organization", "openai-project"]) {
      assert.equal(request.headers.get(name), null, name);
    }
    const verdict = { prediction: 0, reason: "Returns a constant.", evidence: [{ startLine: 1, endLine: 1 }] };
    const chunk = { choices: [{ index: 0, delta: { content: JSON.stringify(verdict) }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const dir = await mkdtemp(join(tmpdir(), "func-audit-test-"));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  function runAudit() {
    process.env.OPENAI_CUSTOM_HEADERS = "Authorization: Bearer personal-key\nX-Personal: personal-value";
    process.env.OPENAI_ORG_ID = "personal-org";
    process.env.OPENAI_PROJECT_ID = "personal-project";
    return reviewSample({ idx: 1, func: "int one(void) { return 1; }" });
  }
  await assert.rejects(runAudit(), /Set FUNC_AUDIT_API_KEY/);
  assert.equal(requests.length, 0);

  process.env.FUNC_AUDIT_API_KEY = "project-key";
  assert.equal((await runAudit()).model, "deepseek/deepseek-flash");
  process.env.FUNC_AUDIT_BASE_URL = "https://gateway.invalid/v1";
  process.env.FUNC_AUDIT_MODEL = "team/custom-deployment";
  assert.equal((await runAudit()).model, "openai-compatible/team/custom-deployment");
  assert.deepEqual(requests, [
    ["https://api.deepseek.com/chat/completions", "Bearer project-key", "deepseek-flash"],
    ["https://gateway.invalid/v1/chat/completions", "Bearer project-key", "team/custom-deployment"],
  ]);
});

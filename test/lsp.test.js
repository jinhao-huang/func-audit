import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceTools } from "../src/source-tools.ts";

test("snapshot navigation resolves an overload and falls back to labeled candidates on a semantic miss", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "func-audit-overloads-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "include"));
  const files = {
    "include/choice.hpp": "struct Number {};\nint pick(int);\nint pick(double);\n",
    "src/choice.cpp": '#include "choice.hpp"\nint pick(int n) { return n; }\n/*注*/ int pick(double n) { return int(n); }\n',
    "src/main.cpp": '#include "choice.hpp"\nint example(Number value) { /*🎵*/ return pick(2.5) + pick(1); }\n',
    "src/unresolved.cpp": '#include "missing-generated-header.hpp"\nint example() { /*🎵🎵🎵🎵🎵*/ return pick(2.5); }\n',
  };
  for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
  await writeFile(join(root, "compile_commands.json"), JSON.stringify(Object.keys(files)
    .filter(file => file.endsWith(".cpp"))
    .map(file => ({ file, directory: root, arguments: ["clang++", "-std=c++17", "-Iinclude", "-c", file] }))));
  const lookups = [];
  await using source = sourceTools(root, call => lookups.push(call));
  const [grep, , lsp] = source.tools;
  const query = async (operation, path, line, column) =>
    (await lsp.execute("l", { operation, path, line, column })).content[0].text;
  const search = async (pattern, path) => (await grep.execute("g", { pattern, path })).content[0].text;
  const call = files["src/main.cpp"].split("\n")[1];
  const first = call.indexOf("pick") + 1;
  const second = call.lastIndexOf("pick") + 1;
  assert.equal(await search("pick", "src/main.cpp"), [first, second]
    .map(column => `src/main.cpp:2:${column}: ${call}`).join("\n"));

  // A cold clangd index can return the correct declaration before it has indexed the body.
  assert.match(await query("definition", "src/main.cpp", 2, first),
    /^clangd definition:\n(?:include\/choice\.hpp:3:5|src\/choice\.cpp:3:11)$/);
  assert.match(await query("hover", "src/choice.cpp", 3, 11), /pick\(double/);
  assert.equal(await query("definition", "src/main.cpp", 2, first), "clangd definition:\nsrc/choice.cpp:3:11");
  assert.equal(await query("definition", "src/main.cpp", 2, second), "clangd definition:\nsrc/choice.cpp:2:5");
  assert.match(await query("references", "src/choice.cpp", 3, 11), new RegExp(`src/main\\.cpp:2:${first}\\b`));
  assert.match(await query("typeDefinition", "src/main.cpp", 2, call.indexOf("value") + 1), /include\/choice.hpp:1:8/);

  const missing = files["src/unresolved.cpp"].split("\n")[1].indexOf("pick") + 1;
  const fallback = await query("definition", "src/unresolved.cpp", 2, missing);
  assert.match(fallback, /clangd returned no in-snapshot result.*\nctags-lsp same-name candidates:/);
  assert.match(fallback, /src\/choice.cpp:2: int pick\(int n\)/);
  assert.match(fallback, /src\/choice.cpp:3: \/\*注\*\/ int pick\(double n\)/);
  assert.deepEqual(lookups.at(-1), { tool: "lsp", args: {
    operation: "definition", path: "src/unresolved.cpp", line: 2, column: missing,
  }, result: fallback });
  assert.match(await query("references", "src/unresolved.cpp", 2, missing), /^clangd returned no in-snapshot result/);
  assert.deepEqual(await readdir(root), ["compile_commands.json", "include", "src"]);
  await symlink(tmpdir(), join(root, "external"));
  await assert.rejects(query("definition", "external", 1, 1), /outside the snapshot/);
  await assert.rejects(query("definition", "src/main.cpp", 2, 500), /position/);
});

test("unavailable language servers report an error instead of an empty result", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "func-audit-no-lsp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "example.c"), "int example;\n");
  const originalPath = process.env.PATH;
  t.mock.property(process, "env", { ...process.env, PATH: root });
  const lookups = [];
  await using source = sourceTools(root, call => lookups.push(call));
  const lsp = source.tools.find(tool => tool.name === "lsp");
  const position = { path: "example.c", line: 1, column: 5 };
  await assert.rejects(lsp.execute("r", { ...position, operation: "references" }), /clangd unavailable:.*ENOENT/);
  assert.doesNotMatch(lookups.at(-1).result, /ctags/);
  await using offline = sourceTools(root, call => lookups.push(call));
  const definition = { ...position, operation: "definition" };
  await assert.rejects(offline.tools.find(tool => tool.name === "lsp").execute("d", definition),
    /clangd unavailable:.*\nctags-lsp unavailable:/);
  assert.equal(lookups.at(-1).error, true);
  // Stall clangd initialization past the first request's deadline. Let the real fallback run.
  await writeFile(join(root, "clangd"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  process.env.PATH = root + ":" + originalPath;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(40), { times: 1 });
  const fallback = await lsp.execute("d", definition);
  assert.match(fallback.content[0].text, /clangd unavailable:.*timeout.*\nctags-lsp same-name candidates:\nexample\.c:1: int example;/i);
  process.env.PATH = originalPath;
  assert.equal((await lsp.execute("d", definition)).content[0].text, "clangd definition:\nexample.c:1:5");
});

test("grep preserves first-line BOM columns and hover stays inside the snapshot", async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "func-audit-hover-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "snapshot");
  await mkdir(root);
  await writeFile(join(temp, "installed.h"), "/// Documentation from outside the snapshot.\nint external(int);\n");
  await writeFile(join(root, "local.h"), "int local(int);\n");
  await writeFile(join(root, "alternative.c"), "static int external(int n) { return n; }\n");
  await writeFile(join(root, "main.c"), '\uFEFFint x;\n#include "local.h"\n#include "../installed.h"\nint f() { return external(x); }\n');
  await using source = sourceTools(root, () => {});
  const [grep, , lsp] = source.tools;
  const lookup = async (operation, line, column) =>
    (await lsp.execute("l", { operation, path: "main.c", line, column })).content[0].text;
  assert.match((await grep.execute("g", { pattern: "x", path: "main.c" })).content[0].text, /^main\.c:1:6:/);
  assert.equal(await lookup("definition", 1, 6), "clangd definition:\nmain.c:1:6");
  const local = await lookup("hover", 2, 12);
  assert.match(local, /local\.h/);
  assert.ok(!local.includes(root));
  assert.equal(await lookup("hover", 4, 18), "clangd returned no in-snapshot result for hover.");
  assert.match(await lookup("definition", 4, 18),
    /^clangd returned no in-snapshot result for definition\.\nctags-lsp same-name candidates:\nalternative\.c:1: static int external/);
});

import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Range = { path: string; startLine: number; endLine: number };
type Search = { pattern: string; path?: string };
export type Lookup = { tool: "read"; args: Range; result: string; error?: true }
  | { tool: "grep"; args: Search; result: string; error?: true };

async function snapshotPath(root: string, input: string) {
  if (!input || isAbsolute(input) || input.split(sep).includes("..")) {
    throw new Error("Use a path relative to the snapshot root.");
  }
  const path = await realpath(resolve(root, input)).catch(() => { throw new Error("Path not found in the snapshot."); });
  const name = relative(root, path);
  if (name === ".." || name.startsWith(`..${sep}`)) throw new Error("Path is outside the snapshot.");
  return name || ".";
}

async function search(root: string, args: Search, signal?: AbortSignal) {
  const path = await snapshotPath(root, args.path ?? ".");
  const child = spawn("rg", [
    "--no-config", "--hidden", "--no-ignore", "--json", "--", args.pattern, path,
  ], { cwd: root, signal, stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<number | null>((res, rej) => {
    child.once("error", rej);
    child.once("close", res);
  });
  child.stderr.resume();
  const matches: string[] = [];
  const collect = async () => {
    for await (const row of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const { type, data } = JSON.parse(row);
      if (type !== "match" || !data.path.text || !data.lines.text) continue;
      if (matches.length === 50) {
        matches.push("[More matches omitted. Narrow the pattern or path.]");
        child.kill();
        break;
      }
      const file = data.path.text.replace(/^\.\//, "");
      const line = data.lines.text.replace(/\r?\n$/, "");
      matches.push(`${file}:${data.line_number}: ${line.length > 500 ? line.slice(0, 500) + "…" : line}`);
    }
  };
  const [code] = await Promise.all([done, collect()]);
  if (code !== 0 && code !== 1 && matches.length <= 50) throw new Error("Search failed. Check the regular expression and path.");
  return matches.join("\n") || "No matches found.";
}

export function sourceTools(root: string, record: (lookup: Lookup) => void) {
  async function run(lookup: Lookup, action: () => Promise<string>) {
    try {
      lookup.result = await action();
    } catch (error) {
      lookup.result = error instanceof Error ? error.message.replaceAll(root, ".") : "Lookup failed.";
      lookup.error = true;
      record(lookup);
      throw new Error(lookup.result);
    }
    record(lookup);
    return { content: [{ type: "text" as const, text: lookup.result }], details: undefined };
  }
  return [
    defineTool({
      name: "grep", label: "Search snapshot",
      description: "Search for a regular expression. Omit path to search the whole snapshot, or specify a relative directory or file. Returns paths, line numbers and matching text.",
      parameters: Type.Object({ pattern: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }),
      execute: async (_id, args, signal) => run({ tool: "grep", args, result: "" }, () => search(root, args, signal)),
    }),
    defineTool({
      name: "read", label: "Read snapshot lines",
      description: "Read the exact text of an inclusive, one-based line range in a snapshot-relative file.",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }) }),
      execute: async (_id, args) => run({ tool: "read", args, result: "" }, async () => {
        const { startLine, endLine } = args;
        const path = resolve(root, await snapshotPath(root, args.path));
        if (!(await stat(path)).isFile()) throw new Error("Choose a file to read.");
        const raw = await readFile(path, "utf8");
        if (raw.includes("\0")) throw new Error("Choose a text file.");
        const lines = raw.split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        if (endLine < startLine || endLine > lines.length) throw new Error(`Invalid range; file has ${lines.length} lines.`);
        const result = lines.slice(startLine - 1, endLine).join("\n");
        if (result.length > 32000) throw new Error("Request a smaller line range.");
        return result;
      }),
    }),
  ];
}

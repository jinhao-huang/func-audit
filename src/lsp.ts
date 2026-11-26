import { spawn } from "node:child_process";
import { addAbortListener, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type, type Static } from "typebox";
import {
  createProtocolConnection, DefinitionRequest, DidOpenTextDocumentNotification, ExitNotification,
  HoverRequest, InitializedNotification, InitializeRequest, ReferencesRequest, ShutdownRequest,
  TypeDefinitionRequest, type Definition, type LocationLink,
} from "vscode-languageserver-protocol/node";
import { snapshotPath } from "./snapshot.ts";

export const lspParameters = Type.Object({
  operation: Type.Enum(["definition", "references", "hover", "typeDefinition"]),
  path: Type.String({ minLength: 1 }),
  line: Type.Integer({ minimum: 1 }),
  column: Type.Integer({ minimum: 1 }),
});
export type LspQuery = Static<typeof lspParameters>;
type Backend = "clangd" | "ctags-lsp";

function startServer(root: string, name: Backend, args: string[]) {
  const child = spawn(name, args, { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const connection = createProtocolConnection(child.stdout, child.stdin);
  let stopped = false;
  connection.onDispose(() => { stopped = true; });
  connection.onClose(() => connection.dispose());
  connection.listen();
  const ready = (async () => {
    await once(child, "spawn");
    const uri = pathToFileURL(root).href;
    const { capabilities } = await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ name: "snapshot", uri }],
      capabilities: { general: { positionEncodings: ["utf-16"] } },
    });
    await connection.sendNotification(InitializedNotification.type, {});
    return capabilities;
  })();
  const opened = new Set<string>();
  const stop = () => {
    connection.dispose();
    child.kill("SIGKILL");
  };
  return {
    get stopped() { return stopped || !child.pid; },
    async query(args: LspQuery, text: string, character: number, signal?: AbortSignal) {
      const deadline = AbortSignal.timeout(60_000);
      const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
      using listener = addAbortListener(abort, stop);
      try {
        const capabilities = await ready;
        abort.throwIfAborted();
        if (!capabilities[`${args.operation}Provider`]) throw new Error(`Unsupported operation: ${args.operation}`);
        const uri = pathToFileURL(join(root, args.path)).href;
        if (!opened.has(uri)) {
          opened.add(uri);
          await connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: args.path.endsWith(".c") ? "c" : "cpp", version: 1, text },
          });
        }
        const params = { textDocument: { uri }, position: { line: args.line - 1, character } };
        switch (args.operation) {
          case "hover": {
            const hover = await connection.sendRequest(HoverRequest.type, params);
            if (!hover) return "";
            // Hover can contain documentation from system headers. Verify its source before returning it.
            const definition = await connection.sendRequest(DefinitionRequest.type, params);
            if (!await locations(root, definition, false)) return "";
            return [hover.contents].flat().map(part => typeof part === "string" ? part : part.value)
              .join("\n").replaceAll(root + sep, "");
          }
          case "references":
            return await connection.sendRequest(ReferencesRequest.type, { ...params, context: { includeDeclaration: false } });
          case "typeDefinition":
            return await connection.sendRequest(TypeDefinitionRequest.type, params);
          case "definition":
            return await connection.sendRequest(DefinitionRequest.type, params);
        }
      } catch (error) {
        abort.throwIfAborted();
        throw error;
      }
    },
    async dispose() {
      const timer = setTimeout(stop, 1000);
      try {
        await connection.sendRequest(ShutdownRequest.type);
        await connection.sendNotification(ExitNotification.type);
      } catch {
        stop();
      } finally {
        await closed;
        clearTimeout(timer);
        connection.dispose();
      }
    },
  };
}

async function locations(root: string, response: Definition | LocationLink[] | null, candidates: boolean) {
  const results = new Set<string>();
  const files = new Map<string, string[]>();
  for (const target of [response ?? []].flat()) {
    const uri = "uri" in target ? target.uri : target.targetUri;
    const { start } = "uri" in target ? target.range : target.targetSelectionRange;
    if (!uri.startsWith("file:")) continue;
    const path = await snapshotPath(root, relative(root, fileURLToPath(uri))).catch(() => undefined);
    if (!path) continue;
    const line = `${path}:${start.line + 1}`;
    if (candidates) {
      // ctags-lsp reports byte columns. Only its file and line identify a candidate reliably.
      if (!files.has(path)) files.set(path, (await readFile(join(root, path), "utf8")).split(/\r?\n/));
      results.add(`${line}: ${files.get(path)![start.line]?.slice(0, 500) ?? ""}`);
    } else {
      results.add(`${line}:${start.character + 1}`);
    }
    if (results.size > 50) break;
  }
  return [...results].slice(0, 50).concat(results.size > 50 ? ["[More locations omitted.]"] : []).join("\n");
}

export function snapshotLsp(root: string) {
  const servers = new Map<Backend, ReturnType<typeof startServer>>();
  let indexDirectory: string | undefined;
  let clangdOptions: Promise<string[]> | undefined;
  async function clangdArguments() {
    const args = ["--enable-config=0"];
    const database = ["compile_commands.json", "build/compile_commands.json"].find(path => existsSync(join(root, path)));
    if (database) {
      // clangd writes its background index beside the compilation database. Keep the snapshot read-only.
      indexDirectory = await mkdtemp(join(tmpdir(), "func-audit-clangd-"));
      await symlink(join(root, await snapshotPath(root, database)), join(indexDirectory, "compile_commands.json"));
      args.push(`--compile-commands-dir=${indexDirectory}`, "--background-index");
    } else {
      args.push("--background-index=0");
    }
    return args;
  }

  return {
    async query(input: LspQuery, signal?: AbortSignal) {
      const path = await snapshotPath(root, input.path);
      const text = await readFile(join(root, path), "utf8");
      const line = text.split(/\r?\n/)[input.line - 1];
      if (text.includes("\0") || !line || input.column < 1 || input.column > line.length) {
        throw new Error("Choose a position on a symbol in a snapshot text file.");
      }
      async function lookup(name: Backend) {
        const args = name === "clangd" ? await (clangdOptions ??= clangdArguments()) : ["--languages=C,C++"];
        signal?.throwIfAborted();
        let server = servers.get(name);
        if (server?.stopped) {
          await server.dispose();
          server = servers.get(name);
        }
        if (!server || server.stopped) {
          server = startServer(root, name, args);
          servers.set(name, server);
        }
        // ctags-lsp reads rune offsets, clangd negotiates UTF-16.
        const column = input.column - 1;
        const character = name === "ctags-lsp" ? [...line.slice(0, column)].length : column;
        const result = await server.query({ ...input, path }, text, character, signal);
        return typeof result === "string" ? result.slice(0, 16000) : locations(root, result, name === "ctags-lsp");
      }
      let reason: string;
      try {
        const result = await lookup("clangd");
        if (result) return `clangd ${input.operation}:\n${result}`;
        reason = `clangd returned no in-snapshot result for ${input.operation}.`;
        if (input.operation !== "definition") return reason;
      } catch (error) {
        signal?.throwIfAborted();
        reason = `clangd unavailable: ${error instanceof Error ? error.message : String(error)}`;
        if (input.operation !== "definition") throw new Error(reason);
      }
      try {
        const result = await lookup("ctags-lsp");
        return `${reason}\n${result ? "ctags-lsp same-name candidates:\n" + result : "ctags-lsp found no same-name candidates."}`;
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`${reason}\nctags-lsp unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dispose() {
      try {
        await Promise.all([...servers.values()].map(server => server.dispose()));
      } finally {
        if (indexDirectory) await rm(indexDirectory, { recursive: true, force: true });
      }
    },
  };
}

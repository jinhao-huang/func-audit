import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function snapshotPath(root: string, input: string) {
  if (!input || isAbsolute(input) || input.split(sep).includes("..")) {
    throw new Error("Use a path relative to the snapshot root.");
  }
  const path = await realpath(resolve(root, input)).catch(() => { throw new Error("Path not found in the snapshot."); });
  const name = relative(root, path);
  if (name === ".." || name.startsWith(`..${sep}`)) throw new Error("Path is outside the snapshot.");
  return name || ".";
}

export type SnapshotProgress =
  | { kind: "download"; bytes: number; total?: number }
  | { kind: "extract" }
  | { kind: "locate" };

function commitLocation(link: string) {
  const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{40})\/?$/.exec(link);
  if (github && !github[1].split("/").some((part) => part === "." || part === "..")) {
    return { repository: github[1].toLowerCase(), commit: github[2] };
  }
  const qemu = /^https:\/\/git\.qemu\.org\/\?p=qemu\.git;a=commit;h=([0-9a-f]{40})$/.exec(link);
  if (qemu) return { repository: "qemu/qemu", commit: qemu[1] };
  throw new Error("Expected a supported repair commit URL with a full commit ID.");
}

function git(directory: string, signal: AbortSignal | undefined, ...args: string[]) {
  signal?.throwIfAborted();
  return exec("git", [`--git-dir=${directory}`, ...args], {
    signal,
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" },
  });
}

async function cacheRepair(repository: string, commit: string,
  onProgress?: (event: SnapshotProgress) => void, signal?: AbortSignal) {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  const directory = join(base, "func-audit/repos/github.com", `${repository}.git`);
  const ref = `refs/func-audit/repairs/${commit}`;
  async function cached() {
    if (!existsSync(join(directory, "HEAD"))) return false;
    try {
      await git(directory, signal, "show-ref", "--verify", "--quiet", ref);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1) return false;
      throw error;
    }
  }
  if (await cached()) return directory;
  await mkdir(directory, { recursive: true });
  // One writer per repository, including workers from other worktrees. Closing the
  // connection releases the transaction on success, failure, or process exit.
  using lock = new DatabaseSync(join(directory, "fetch-lock.sqlite"));
  while (true) {
    try {
      lock.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      if (!(error instanceof Error && "errcode" in error && error.errcode === 5)) throw error;
      await delay(100, undefined, { signal });
    }
  }
  if (!await cached()) {
    if (!existsSync(join(directory, "HEAD"))) await git(directory, signal, "init", "--bare");
    onProgress?.({ kind: "download", bytes: 0 });
    const fetch = git(directory, signal, "-c", "fetch.unpackLimit=1", "fetch", "--progress", "--no-tags",
      "--depth=2", `https://github.com/${repository}.git`, `${commit}:${ref}`);
    const lines = createInterface({ input: fetch.child.stderr! });
    const units = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
    let reported = 0;
    async function reportBytes() {
      for await (const line of lines) {
        const match = /^Receiving objects:.*?, ([\d.]+) (bytes|KiB|MiB|GiB) \|/.exec(line);
        if (!match) continue;
        const bytes = Math.round(Number(match[1]) * units[match[2] as keyof typeof units]);
        if (bytes > reported) onProgress?.({ kind: "download", bytes });
        reported = bytes;
      }
    }
    try {
      await Promise.all([fetch, reportBytes()]);
    } catch (error) {
      fetch.child.kill();
      await fetch.catch(() => {});
      throw error;
    } finally {
      lines.close();
    }
  }
  return directory;
}

async function checkArchiveCase(archive: string, signal?: AbortSignal) {
  const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024, signal });
  const paths = new Map<string, string>();
  for (const path of stdout.trimEnd().split("\n")) {
    const key = path.replace(/\/$/, "").toLowerCase();
    const previous = paths.get(key);
    if (previous !== undefined && previous !== path) {
      throw new Error(`Snapshot contains conflicting paths "${previous}" and "${path}". Set TMPDIR to a directory on a case-sensitive volume.`);
    }
    paths.set(key, path);
  }
}

export async function prepareSnapshot(link: string, target: number, source: string,
  onProgress?: (event: SnapshotProgress) => void, signal?: AbortSignal) {
  const { repository, commit } = commitLocation(link);
  if (target !== 0 && target !== 1) throw new Error("Snapshot preparation requires a binary target.");
  const directory = await cacheRepair(repository, commit, onProgress, signal);
  let revision = commit;
  if (target === 1) {
    const { stdout } = await git(directory, signal, "cat-file", "-p", commit);
    const parents = [...stdout.split("\n\n", 1)[0].matchAll(/^parent ([0-9a-f]{40})$/gm)];
    if (parents.length !== 1) throw new Error("The repair commit must have one identifiable parent.");
    revision = parents[0][1];
  }
  const temp = await mkdtemp(join(tmpdir(), "func-audit-snapshot-"));
  const dispose = () => rm(temp, { recursive: true, force: true });
  try {
    const root = join(await realpath(temp), "source");
    await mkdir(root);
    const archive = join(temp, "snapshot.tar.gz");
    onProgress?.({ kind: "extract" });
    await git(directory, signal, "archive", "--format=tar.gz", "-o", archive, revision);
    // A Git tree can contain both xt_DSCP.h and xt_dscp.h.
    if (existsSync(join(temp, "SOURCE"))) await checkArchiveCase(archive, signal);
    await exec("tar", ["-xzf", archive, "-C", root], { signal });
    await rm(archive);
    onProgress?.({ kind: "locate" });
    const location = await locateFunction(root, source, signal);
    return { root, metadata: { repository, revision, ...location }, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function locateFunction(root: string, source: string, signal?: AbortSignal) {
  // Course snippets can differ in indentation and blank lines from the checked-in source.
  const wanted = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const anchor = wanted.reduce((best, line) => line.length > best.length ? line : best);
  const { stdout } = await exec("rg", [
    "--no-config", "--no-ignore", "--hidden", "-l", "-0", "-F", "--", anchor, ".",
  ], { cwd: root, maxBuffer: 16 * 1024 * 1024, signal }).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  let match: { path: string; startLine: number; endLine: number } | undefined;
  for (const file of stdout.split("\0").filter(Boolean)) {
    const raw = await readFile(join(root, file), { encoding: "utf8", signal });
    const lines = raw.split(/\r?\n/).map((text, index) => ({ text: text.trim(), number: index + 1 }))
      .filter((line) => line.text);
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      if (lines[i].text !== wanted[0] || !wanted.every((text, j) => text === lines[i + j].text)) continue;
      if (match) throw new Error("The supplied function matches multiple locations in the selected revision.");
      match = { path: file.replace(/^\.\//, ""), startLine: lines[i].number, endLine: lines[i + wanted.length - 1].number };
    }
  }
  if (!match) throw new Error("The supplied function was not found in the selected revision.");
  return match;
}

export type SnapshotMetadata = Awaited<ReturnType<typeof prepareSnapshot>>["metadata"];

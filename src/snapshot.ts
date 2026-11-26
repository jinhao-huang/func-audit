import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;

function commitLocation(link: string) {
  const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{40})\/?$/.exec(link);
  if (github && !github[1].split("/").some((part) => part === "." || part === "..")) {
    return { repository: github[1], commit: github[2] };
  }
  const qemu = /^https:\/\/git\.qemu\.org\/\?p=qemu\.git;a=commit;h=([0-9a-f]{40})$/.exec(link);
  if (qemu) return { repository: "qemu/qemu", commit: qemu[1] };
  throw new Error("Expected a supported repair commit URL with a full commit ID.");
}

async function download(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status} at ${url}`);
  return response;
}

async function checkArchiveCase(archive: string) {
  const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
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

export async function prepareSnapshot(link: string, target: number, source: string) {
  const { repository, commit } = commitLocation(link);
  if (target !== 0 && target !== 1) throw new Error("Snapshot preparation requires a binary target.");
  let revision = commit;
  if (target === 1) {
    const response = await download(`https://api.github.com/repos/${repository}/git/commits/${commit}`);
    const { parents } = await response.json();
    if (!Array.isArray(parents) || parents.length !== 1 || !sha.test(parents[0]?.sha)) {
      throw new Error("The repair commit must have one identifiable parent.");
    }
    revision = parents[0].sha;
  }
  const temp = await mkdtemp(join(tmpdir(), "func-audit-snapshot-"));
  const dispose = () => rm(temp, { recursive: true, force: true });
  try {
    const root = join(await realpath(temp), "source");
    await mkdir(root);
    const archive = join(temp, "snapshot.tar.gz");
    const response = await download(`https://codeload.github.com/${repository}/tar.gz/${revision}`);
    if (!response.body) throw new Error("The source archive is empty.");
    await writeFile(archive, response.body);
    // A Git tree can contain both xt_DSCP.h and xt_dscp.h.
    if (existsSync(join(temp, "SOURCE"))) await checkArchiveCase(archive);
    await exec("tar", ["-xzf", archive, "--strip-components=1", "-C", root]);
    const location = await locateFunction(root, source);
    return { root, metadata: { repository, revision, ...location }, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function locateFunction(root: string, source: string) {
  // Course snippets can differ in indentation and blank lines from the checked-in source.
  const wanted = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const anchor = wanted.reduce((best, line) => line.length > best.length ? line : best);
  const { stdout } = await exec("rg", [
    "--no-config", "--no-ignore", "--hidden", "-l", "-0", "-F", "--", anchor, ".",
  ], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).catch((error) => {
    if (error.code === 1) return { stdout: "" };
    throw error;
  });
  let match: { path: string; startLine: number; endLine: number } | undefined;
  for (const file of stdout.split("\0").filter(Boolean)) {
    const raw = await readFile(join(root, file), "utf8");
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

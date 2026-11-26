import {
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectApi } from "./project-api.ts";
import { sourceTools, type Lookup } from "./source-tools.ts";
import type { SnapshotMetadata } from "./snapshot.ts";

const auditInstructions = `Review the numbered C or C++ function for a code maintainer.
Return a single JSON object with these fields:
- prediction: 1 if the code shows a vulnerability, otherwise 0.
- reason: a short explanation of the decision and any relevant uncertainty.
- evidence: one or more objects with integer startLine and endLine (inclusive)
  citing the lines that support the explanation.`;

// Pi's explicit resource interface keeps local extensions, skills and context files out of the review.
const resources: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => auditInstructions,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources() {},
  async reload() {},
};

function parseReview(reply: string, lines: string[], lookups: Lookup[]) {
  const json = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  const value = JSON.parse(json);
  if (value?.prediction !== 0 && value?.prediction !== 1) {
    throw new Error("Expected a binary prediction.");
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    throw new Error("Expected a reason for the prediction.");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error("Expected at least one source citation.");
  }
  const evidence = value.evidence.map((range: { path?: string; startLine: number; endLine: number }) => {
    const { path, startLine, endLine } = range;
    let citedLines = lines;
    let first = 1;
    if (path !== undefined) {
      const read = lookups.find((call) => call.tool === "read" && !call.error && call.args.path === path
        && call.args.startLine <= startLine && call.args.endLine >= endLine);
      if (read?.tool !== "read") throw new Error("Snapshot citation must refer to lines returned by read.");
      citedLines = read.result.split("\n");
      first = read.args.startLine;
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < first || endLine < startLine || endLine >= first + citedLines.length) {
      throw new Error(`Invalid source citation: ${startLine}–${endLine}.`);
    }
    const source = citedLines.slice(startLine - first, endLine - first + 1).join("\n");
    if (!source.trim()) throw new Error(`Empty source citation: ${startLine}–${endLine}.`);
    return { ...(path === undefined ? {} : { path }), startLine, endLine, source };
  });
  return { prediction: value.prediction, reason: value.reason.trim(), evidence };
}

export async function reviewFunction(source: string, snapshot?: {
  root: string;
  location: Pick<SnapshotMetadata, "path" | "startLine" | "endLine">;
  onLookups: (lookups: Lookup[]) => void;
}) {
  const { modelRuntime, model } = await projectApi();
  const lines = source.split(/\r?\n/);
  const numbered = lines.map((line, i) => `${i + 1} | ${line}`).join("\n");
  let lookups: Lookup[] = [];
  let traceFailure: Error | undefined;
  const tools = snapshot ? sourceTools(snapshot.root, (lookup) => {
    const next = [...lookups, lookup];
    try {
      snapshot.onLookups(next);
    } catch (cause) {
      traceFailure = new Error(`Could not save snapshot lookup: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      session.agent.abort();
      throw traceFailure;
    }
    lookups = next;
  }) : [];
  const guidance = snapshot
    ? "Use grep or read when the supplied function needs context. For evidence from read, include "
      + "the requested path and inclusive file line numbers. For the supplied function, omit path "
      + "and use the numbered function lines."
    : "Use only the supplied function.";
  const { session } = await createAgentSession({
    cwd: "/",
    model,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: { ...resources, getSystemPrompt: () => `${auditInstructions}\n${guidance}` },
    sessionManager: SessionManager.inMemory("/"),
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });
  try {
    const location = snapshot?.location;
    await session.prompt(location
      ? `Function at ${location.path}, file lines ${location.startLine}–${location.endLine}.\n\n${numbered}`
      : numbered);
    if (traceFailure) throw traceFailure;
    const message = session.messages.findLast((entry) => entry.role === "assistant");
    if (message?.stopReason !== "stop") {
      throw new Error(message?.errorMessage ?? `Incomplete model response: ${message?.stopReason ?? "missing"}.`);
    }
    const text = session.getLastAssistantText();
    if (!text) throw new Error("Pi returned an empty response.");
    return { model: `${message.provider}/${message.model}`, ...parseReview(text, lines, lookups) };
  } finally {
    session.dispose();
  }
}

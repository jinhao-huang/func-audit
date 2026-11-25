import {
  createAgentSession,
  createExtensionRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectApi } from "./project-api.ts";

const auditInstructions = `Review the numbered C or C++ function for a code maintainer.
Use only the supplied function. Return a single JSON object with these fields:
- prediction: 1 if the code shows a vulnerability, otherwise 0.
- reason: a short explanation of the decision and any relevant uncertainty.
- evidence: one or more objects with integer startLine and endLine (inclusive)
  citing the function lines that support the explanation.`;

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

function parseReview(reply: string, lines: string[]) {
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
  const evidence = value.evidence.map((range: { startLine: number; endLine: number }) => {
    const { startLine, endLine } = range;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < 1 || endLine < startLine || endLine > lines.length) {
      throw new Error(`Invalid source citation: ${startLine}–${endLine}.`);
    }
    const source = lines.slice(startLine - 1, endLine).join("\n");
    if (!source.trim()) throw new Error(`Empty source citation: ${startLine}–${endLine}.`);
    return { startLine, endLine, source };
  });
  return { prediction: value.prediction, reason: value.reason.trim(), evidence };
}

export async function reviewFunction(source: string) {
  const { modelRuntime, model } = await projectApi();
  const lines = source.split(/\r?\n/);
  const numbered = lines.map((line, i) => `${i + 1} | ${line}`).join("\n");
  const { session } = await createAgentSession({
    cwd: "/",
    model,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory("/"),
    tools: [],
  });
  try {
    await session.prompt(numbered);
    const message = session.messages.findLast((entry) => entry.role === "assistant");
    if (message?.stopReason !== "stop") {
      throw new Error(message?.errorMessage ?? `Incomplete model response: ${message?.stopReason ?? "missing"}.`);
    }
    const text = session.getLastAssistantText();
    if (!text) throw new Error("Pi returned an empty response.");
    return { model: `${message.provider}/${message.model}`, ...parseReview(text, lines) };
  } finally {
    session.dispose();
  }
}

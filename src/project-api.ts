import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function projectApi() {
  const apiKey = process.env.FUNC_AUDIT_API_KEY?.trim();
  if (!apiKey) throw new Error("Set FUNC_AUDIT_API_KEY to the project API key.");
  const baseUrl = process.env.FUNC_AUDIT_BASE_URL?.trim() || "https://api.deepseek.com";
  const modelId = process.env.FUNC_AUDIT_MODEL?.trim() || "deepseek-flash";

  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const official = new URL(baseUrl).origin === "https://api.deepseek.com";
  const catalogModel = official && modelRuntime.getModel("deepseek", modelId);
  const provider = catalogModel ? "deepseek" : "openai-compatible";
  await credentials.modify(provider, async () => ({ type: "api_key", key: apiKey }));
  if (catalogModel) return { modelRuntime, model: { ...catalogModel, baseUrl } };

  // The gateway owns the model ID. These local budgets cover a single text review.
  modelRuntime.registerProvider(provider, {
    api: "openai-completions",
    baseUrl,
    models: [{
      id: modelId,
      name: modelId,
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false },
    }],
  });
  return { modelRuntime, model: modelRuntime.getModel(provider, modelId)! };
}

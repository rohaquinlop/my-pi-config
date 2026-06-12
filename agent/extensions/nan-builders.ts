/**
 * NaN Builders Custom Provider Extension
 *
 * Registers the "nan" provider (NaN.builders) with:
 * - OpenAI-compatible Chat Completions API (api: "openai-completions")
 * - Dynamic model list fetched from GET /v1/models at startup
 * - /login support under "Use an API key" — paste your API key interactively
 *   (key stored in ~/.pi/agent/auth.json automatically)
 *
 * Usage:
 *   1. Restart pi or run /reload
 *   2. Run /login, pick "Use an API key", then select "NaN Builders"
 *   3. Paste your API key when prompted
 *   4. Use /model to select a model from the "nan" provider
 *
 * API docs: https://nan.builders/docs/api
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-ai";

// =============================================================================
// Known model capabilities (from https://nan.builders/docs/api)
// =============================================================================

interface ModelCapabilities {
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    thinkingLevelMap: {
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    },
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: true,
    },
  },
  "mimo-v2.5": {
    name: "MiMo V2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    thinkingLevelMap: {
      off: null, // reasoning is always on, cannot be disabled via API
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  },
  "qwen3.6": {
    name: "Qwen 3.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 65_536,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
      thinkingFormat: "qwen-chat-template",
    },
  },
  gemma4: {
    name: "Gemma 4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 65_536,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
      thinkingFormat: "qwen-chat-template",
    },
  },
};

const DEFAULT_MODEL_CONFIG: ModelCapabilities = {
  name: "",
  reasoning: false,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const PROVIDER_NAME = "nan";
const BASE_URL = "https://api.nan.builders/v1";

// =============================================================================
// Helper: build a ProviderModelConfig from a ModelCapabilities entry
// =============================================================================

function modelConfig(id: string, caps: ModelCapabilities): ProviderModelConfig {
  const config: ProviderModelConfig = {
    id,
    name: caps.name || id,
    reasoning: caps.reasoning,
    input: caps.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: caps.contextWindow,
    maxTokens: caps.maxTokens,
  };
  if (caps.compat) config.compat = caps.compat as ProviderModelConfig["compat"];
  if (caps.thinkingLevelMap) config.thinkingLevelMap = caps.thinkingLevelMap;
  return config;
}

function buildKnownModels(): ProviderModelConfig[] {
  return Object.entries(KNOWN_MODELS).map(([id, caps]) => modelConfig(id, caps));
}

// =============================================================================
// Fetch models from the API
// =============================================================================

async function fetchModels(): Promise<ProviderModelConfig[] | null> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    data: Array<{ id: string }>;
  };

  return payload.data.map((m) => {
    const known = KNOWN_MODELS[m.id];
    if (known) return modelConfig(m.id, known);

    // Unknown model — use defaults
    return {
      ...DEFAULT_MODEL_CONFIG,
      id: m.id,
      name: m.id,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
}

// =============================================================================
// (No OAuth needed — API key entry is handled by pi's built-in
//  "Use an API key" flow via showApiKeyLoginDialog.)
// =============================================================================

/**
 * Environment variable fallback for the API key.
 * Users can also set the key interactively via /login → "Use an API key".
 */
const FALLBACK_API_KEY = "$NAN_BUILDERS_API_KEY";

// =============================================================================
// Extension entry point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  // 1. Fetch models from the API.
  //    If the fetch fails, fall back to known models.
  let models: ProviderModelConfig[];

  try {
    const fetched = await fetchModels();
    models = fetched ?? buildKnownModels();
  } catch {
    models = buildKnownModels();
  }

  // 2. Register the provider as an API-key-based provider.
  //    The provider appears under "Use an API key" in /login.
  //    When selected, pi's built-in showApiKeyLoginDialog prompts
  //    for the key and stores it in ~/.pi/agent/auth.json.
  //    FALLBACK_API_KEY provides an env-var fallback ($NAN_BUILDERS_API_KEY).
  pi.registerProvider(PROVIDER_NAME, {
    name: "NaN Builders",
    baseUrl: BASE_URL,
    apiKey: FALLBACK_API_KEY,
    api: "openai-completions",
    models,
  });
}

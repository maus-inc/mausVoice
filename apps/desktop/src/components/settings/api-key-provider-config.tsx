import type { ReactNode } from "react";
import type { ApiKeyProvider } from "@maus-inc/types";
import {
  aldeaTestIntegration,
  assemblyaiTestIntegration,
  azureOpenAITestIntegration,
  azureTestIntegration,
  cerebrasTestIntegration,
  claudeTestIntegration,
  deepgramTestIntegration,
  deepseekTestIntegration,
  elevenlabsTestIntegration,
  geminiTestIntegration,
  gladiaTestIntegration,
  groqTestIntegration,
  openaiCompatibleTestIntegration,
  openaiTestIntegration,
  openrouterTestIntegration,
  xaiTestIntegration,
} from "@maus-inc/voice-ai";
import { FormattedMessage } from "react-intl";
import type { SettingsApiKey } from "../../state/settings.state";
import {
  OLLAMA_DEFAULT_URL,
  ollamaTestIntegration,
} from "../../utils/ollama.utils";
import { OPENAI_COMPATIBLE_DEFAULT_URL } from "../../utils/openai-compatible.utils";
import {
  createOpenAICompatibleFetch,
  secureFetch,
} from "../../utils/secure-fetch.utils";
import {
  SPEACHES_DEFAULT_URL,
  speachesTestIntegration,
} from "../../utils/speaches.utils";
import type { ApiKeyListContext } from "./ApiKeyList";

export type ProviderFieldDescriptor = {
  key: string;
  label: ReactNode;
  placeholder: string;
  helperText?: ReactNode;
  type?: "password" | "text";
  required: boolean;
};

export type ProviderFormConfig = {
  displayName: string;
  fields: ProviderFieldDescriptor[];
  showIncludeV1Path?: boolean;
  defaultBaseUrl?: string;
  testIntegration: (
    apiKey: SettingsApiKey,
    context: ApiKeyListContext,
  ) => Promise<boolean>;
};

const API_KEY_FIELD: ProviderFieldDescriptor = {
  key: "apiKey",
  label: <FormattedMessage defaultMessage="API key" />,
  placeholder: "Paste your API key",
  type: "password",
  required: true,
};

const OPTIONAL_API_KEY_FIELD: ProviderFieldDescriptor = {
  ...API_KEY_FIELD,
  label: <FormattedMessage defaultMessage="API key (optional)" />,
  placeholder: "Leave empty if not required",
  helperText: (
    <FormattedMessage defaultMessage="Only needed if your instance requires authentication" />
  ),
  required: false,
};

function requireApiKey(apiKey: SettingsApiKey): string {
  if (!apiKey.keyFull) {
    throw new Error("The stored API key value is unavailable.");
  }
  return apiKey.keyFull;
}

function standardTestConfig(
  testFn: (args: {
    apiKey: string;
    customFetch?: typeof globalThis.fetch;
  }) => Promise<boolean>,
): ProviderFormConfig["testIntegration"] {
  return (apiKey) =>
    testFn({ apiKey: requireApiKey(apiKey), customFetch: secureFetch });
}

/**
 * Providers that `getProviderFormConfig` routes to a dedicated config instead
 * of the shared API-key-only form. Every other `ApiKeyProvider` value must
 * have a `STANDARD_PROVIDERS` entry, which the `Record` type below enforces at
 * compile time: adding a provider to `API_KEY_PROVIDERS` without a form config
 * fails `check-types` instead of throwing
 * "Cannot read properties of undefined (reading 'displayName')" when the AI
 * Transcription settings page renders the provider list.
 */
type DedicatedConfigProvider =
  "azure" | "ollama" | "assemblyai" | "openai-compatible" | "speaches";

type StandardProvider = Exclude<ApiKeyProvider, DedicatedConfigProvider>;

const STANDARD_PROVIDERS: Record<
  StandardProvider,
  {
    displayName: string;
    testFn: (args: {
      apiKey: string;
      customFetch?: typeof globalThis.fetch;
    }) => Promise<boolean>;
  }
> = {
  groq: { displayName: "Groq", testFn: groqTestIntegration },
  openai: { displayName: "OpenAI", testFn: openaiTestIntegration },
  openrouter: { displayName: "OpenRouter", testFn: openrouterTestIntegration },
  aldea: { displayName: "Aldea", testFn: aldeaTestIntegration },
  deepgram: { displayName: "Deepgram", testFn: deepgramTestIntegration },
  gladia: { displayName: "Gladia", testFn: gladiaTestIntegration },
  elevenlabs: { displayName: "ElevenLabs", testFn: elevenlabsTestIntegration },
  deepseek: { displayName: "DeepSeek", testFn: deepseekTestIntegration },
  gemini: { displayName: "Gemini", testFn: geminiTestIntegration },
  claude: { displayName: "Claude", testFn: claudeTestIntegration },
  cerebras: { displayName: "Cerebras", testFn: cerebrasTestIntegration },
  xai: { displayName: "xAI Grok", testFn: xaiTestIntegration },
};

function buildStandardConfig(provider: ApiKeyProvider): ProviderFormConfig {
  const entry = STANDARD_PROVIDERS[provider as StandardProvider];
  // A persisted key can carry a provider string this build does not know
  // (a downgrade, or a row written by a newer version). The type-level
  // `Record<StandardProvider, ...>` already blocks the in-repo case, so this
  // guard only covers foreign data — and it names the provider instead of
  // failing later on `undefined.displayName`.
  if (!entry) {
    throw new Error(
      `Unsupported API key provider "${provider}": no form configuration is registered for it.`,
    );
  }
  return {
    displayName: entry.displayName,
    fields: [API_KEY_FIELD],
    testIntegration: standardTestConfig(entry.testFn),
  };
}

const ASSEMBLYAI_MODEL_FIELD: ProviderFieldDescriptor = {
  key: "transcriptionModel",
  label: <FormattedMessage defaultMessage="Model" />,
  placeholder: "universal-3-5-pro",
  helperText: (
    <FormattedMessage defaultMessage="AssemblyAI speech model. Universal-3.5 Pro keeps Universal-2 as a fallback; leave empty to use the AssemblyAI default." />
  ),
  required: false,
};

const ASSEMBLYAI_CONFIG: ProviderFormConfig = {
  displayName: "AssemblyAI",
  fields: [API_KEY_FIELD, ASSEMBLYAI_MODEL_FIELD],
  testIntegration: (apiKey) =>
    assemblyaiTestIntegration({
      apiKey: requireApiKey(apiKey),
      model: apiKey.transcriptionModel ?? null,
      customFetch: secureFetch,
    }),
};

const OLLAMA_CONFIG: ProviderFormConfig = {
  displayName: "Ollama",
  defaultBaseUrl: OLLAMA_DEFAULT_URL,
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Base URL" />,
      placeholder: OLLAMA_DEFAULT_URL,
      helperText: (
        <FormattedMessage defaultMessage="Leave empty to use the default URL" />
      ),
      required: false,
    },
    OPTIONAL_API_KEY_FIELD,
  ],
  testIntegration: (apiKey) =>
    ollamaTestIntegration({
      baseUrl: apiKey.baseUrl || OLLAMA_DEFAULT_URL,
      apiKey: apiKey.keyFull || undefined,
    }),
};

function getOpenAICompatibleConfig(
  context: ApiKeyListContext,
): ProviderFormConfig {
  let fields: ProviderFieldDescriptor[] = [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Base URL" />,
      placeholder: OPENAI_COMPATIBLE_DEFAULT_URL,
      helperText: (
        <FormattedMessage defaultMessage="Leave empty to use the default URL" />
      ),
      required: false,
    },
    OPTIONAL_API_KEY_FIELD,
  ];
  if (context === "transcription") {
    fields = fields.concat([
      {
        key: "transcriptionModel",
        label: <FormattedMessage defaultMessage="Model" />,
        placeholder: "whisper-1",
        helperText: (
          <FormattedMessage defaultMessage="Transcription model name (e.g. whisper-1, gpt-4o-transcribe)" />
        ),
        required: false,
      },
      {
        key: "transcriptionPath",
        label: <FormattedMessage defaultMessage="Transcription path" />,
        placeholder: "/audio/transcriptions",
        helperText: (
          <FormattedMessage defaultMessage="Replaces only the path after the base URL. For Open WebUI, enter /v1/audio/transcriptions and turn off Include /v1 path; otherwise leave empty." />
        ),
        required: false,
      },
    ]);
  }
  return {
    displayName: "OpenAI Compatible",
    defaultBaseUrl: OPENAI_COMPATIBLE_DEFAULT_URL,
    showIncludeV1Path: true,
    fields,
    testIntegration: (apiKey) =>
      openaiCompatibleTestIntegration({
        baseUrl: apiKey.baseUrl || OPENAI_COMPATIBLE_DEFAULT_URL,
        apiKey: apiKey.keyFull || undefined,
        customFetch: createOpenAICompatibleFetch(apiKey.id),
      }),
  };
}

const SPEACHES_CONFIG: ProviderFormConfig = {
  displayName: "Speaches",
  defaultBaseUrl: SPEACHES_DEFAULT_URL,
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Speaches URL" />,
      placeholder: SPEACHES_DEFAULT_URL,
      helperText: (
        <FormattedMessage defaultMessage="URL of your local Speaches Docker instance" />
      ),
      required: false,
    },
    {
      key: "transcriptionModel",
      label: <FormattedMessage defaultMessage="Model" />,
      placeholder: "Systran/faster-whisper-large-v3",
      helperText: (
        <FormattedMessage defaultMessage="Whisper model ID available in your Speaches instance" />
      ),
      required: false,
    },
  ],
  testIntegration: (apiKey) =>
    speachesTestIntegration({
      baseUrl: apiKey.baseUrl || SPEACHES_DEFAULT_URL,
    }),
};

const AZURE_OPENAI_CONFIG: ProviderFormConfig = {
  displayName: "Azure OpenAI",
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Azure OpenAI Endpoint" />,
      placeholder: "https://my-resource.openai.azure.com",
      helperText: (
        <FormattedMessage defaultMessage="Your Azure OpenAI resource endpoint URL" />
      ),
      required: true,
    },
    {
      ...API_KEY_FIELD,
      placeholder: "Paste your Azure OpenAI API key",
    },
  ],
  testIntegration: (apiKey) => {
    const key = requireApiKey(apiKey);
    if (!apiKey.baseUrl) {
      throw new Error("Azure OpenAI endpoint is required.");
    }
    return azureOpenAITestIntegration({
      apiKey: key,
      endpoint: apiKey.baseUrl,
      customFetch: secureFetch,
    });
  },
};

const AZURE_STT_CONFIG: ProviderFormConfig = {
  displayName: "Azure",
  fields: [
    {
      key: "azureRegion",
      label: <FormattedMessage defaultMessage="Azure Region" />,
      placeholder: "e.g., eastus, westus, northeurope",
      helperText: (
        <FormattedMessage defaultMessage="Azure service region for Speech-to-Text" />
      ),
      required: true,
    },
    {
      ...API_KEY_FIELD,
      label: <FormattedMessage defaultMessage="Subscription Key" />,
      placeholder: "Paste your Azure subscription key",
    },
  ],
  testIntegration: (apiKey) => {
    const key = requireApiKey(apiKey);
    if (!apiKey.azureRegion) {
      throw new Error("Azure region is required.");
    }
    return azureTestIntegration({
      subscriptionKey: key,
      region: apiKey.azureRegion,
    });
  },
};

/**
 * A provider's display name, or null when this build has no config for it.
 *
 * A persisted key can carry a provider string written by a newer build, and the
 * surfaces that name a provider in running copy (the audio disclosure, the
 * overview's model rows) must not crash over one. `getProviderFormConfig`
 * throws for a provider it has no config for, which is why this wraps it rather
 * than letting each caller decide.
 */
export const getProviderDisplayName = (
  provider: ApiKeyProvider,
  context: ApiKeyListContext,
): string | null => {
  try {
    return getProviderFormConfig(provider, context).displayName;
  } catch {
    return null;
  }
};

/**
 * Where a provider's work actually happens.
 *
 * A provider is not the same thing as a cloud service. Ollama, Speaches and an
 * OpenAI-compatible server are all addressed by a base URL that defaults to
 * loopback and may point anywhere, so a surface that writes "Cloud" beside them
 * is making a claim it cannot support — wrong for the machine sitting on the
 * person's desk, and wrong for the privacy story the app tells elsewhere.
 *
 * `unknown` is a real answer rather than a fallback to `cloud`: a base URL that
 * cannot be read tells us nothing about where the bytes go, and the caller then
 * reports no location instead of a wrong one.
 */
export type ProviderLocation = "local" | "cloud" | "unknown";

/** Providers addressed by a base URL the person supplies. */
const ENDPOINT_PROVIDERS: ReadonlySet<ApiKeyProvider> = new Set([
  "ollama",
  "speaches",
  "openai-compatible",
]);

const LOOPBACK_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * The URL each endpoint provider falls back to, so "no base URL saved" is not
 * mistaken for "no location known": the request path uses these same defaults.
 */
const DEFAULT_ENDPOINT_URLS: Partial<Record<ApiKeyProvider, string>> = {
  ollama: OLLAMA_DEFAULT_URL,
  speaches: SPEACHES_DEFAULT_URL,
  "openai-compatible": OPENAI_COMPATIBLE_DEFAULT_URL,
};

export const getProviderLocation = (
  provider: ApiKeyProvider,
  baseUrl: string | null | undefined,
): ProviderLocation => {
  if (!ENDPOINT_PROVIDERS.has(provider)) {
    return "cloud";
  }
  const url = baseUrl?.trim() || DEFAULT_ENDPOINT_URLS[provider];
  if (!url) {
    return "unknown";
  }
  try {
    return LOOPBACK_HOST.test(new URL(url).hostname) ? "local" : "cloud";
  } catch {
    return "unknown";
  }
};

export function getProviderFormConfig(
  provider: ApiKeyProvider,
  context: ApiKeyListContext,
): ProviderFormConfig {
  if (provider === "azure") {
    return context === "transcription" ? AZURE_STT_CONFIG : AZURE_OPENAI_CONFIG;
  }
  if (provider === "ollama") return OLLAMA_CONFIG;
  if (provider === "assemblyai") return ASSEMBLYAI_CONFIG;
  if (provider === "openai-compatible")
    return getOpenAICompatibleConfig(context);
  if (provider === "speaches") return SPEACHES_CONFIG;
  return buildStandardConfig(provider);
}

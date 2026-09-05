import type { ApiKeyProvider } from "@maus-inc/types";
import { Nullable } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getAppState } from "../store";
import { buildGladiaCustomizations } from "../utils/gladia.utils";
import { getLogger } from "../utils/log.utils";
import { OLLAMA_DEFAULT_URL } from "../utils/ollama.utils";
import { buildOpenAICompatibleUrl } from "../utils/openai-compatible.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import {
  ApiGenerativePrefs,
  GenerativePrefs,
  getAgentModePrefs,
  getGenerativePrefs,
  getTranscriptionPrefs,
} from "../utils/user.utils";
import { BaseApiKeyRepo, LocalApiKeyRepo } from "./api-key.repo";
import { BaseAppTargetRepo, LocalAppTargetRepo } from "./app-target.repo";
import { BaseAuthRepo, PersonalAuthRepo } from "./auth.repo";
import { BaseChatMessageRepo, LocalChatMessageRepo } from "./chat-message.repo";
import {
  BaseConversationRepo,
  LocalConversationRepo,
} from "./conversation.repo";
import {
  AzureOpenAIGenerateTextRepo,
  BaseGenerateTextRepo,
  CerebrasGenerateTextRepo,
  ClaudeGenerateTextRepo,
  DeepseekGenerateTextRepo,
  GeminiGenerateTextRepo,
  GroqGenerateTextRepo,
  OllamaGenerateTextRepo,
  OpenAICompatibleGenerateTextRepo,
  OpenAIGenerateTextRepo,
  OpenRouterGenerateTextRepo,
} from "./generate-text.repo";
import { BaseHotkeyRepo, LocalHotkeyRepo } from "./hotkey.repo";
import { BaseMemberRepo, LocalMemberRepo } from "./member.repo";
import { BaseNativeRepo, LocalNativeRepo } from "./native.repo";
import {
  AldeaModelProviderRepo,
  AssemblyAIModelProviderRepo,
  AzureModelProviderRepo,
  BaseModelProviderRepo,
  CerebrasModelProviderRepo,
  ClaudeModelProviderRepo,
  DeepgramModelProviderRepo,
  DeepSeekModelProviderRepo,
  ElevenLabsModelProviderRepo,
  GeminiModelProviderRepo,
  GladiaModelProviderRepo,
  GroqModelProviderRepo,
  OllamaModelProviderRepo,
  OpenAICompatibleModelProviderRepo,
  OpenAIModelProviderRepo,
  OpenRouterModelProviderRepo,
  SpeachesModelProviderRepo,
  XaiModelProviderRepo,
} from "./model-provider.repo";
import {
  BasePairedRemoteDeviceRepo,
  LocalPairedRemoteDeviceRepo,
} from "./paired-remote-device.repo";
import {
  BaseUserPreferencesRepo,
  LocalUserPreferencesRepo,
} from "./preferences.repo";
import {
  BaseRemoteReceiverRepo,
  LocalRemoteReceiverRepo,
} from "./remote-receiver.repo";
import { BaseStorageRepo, LocalStorageRepo } from "./storage.repo";
import { BaseTermRepo, LocalTermRepo } from "./term.repo";
import { BaseToneRepo, LocalToneRepo } from "./tone.repo";
import { ToolRepo } from "./tool.repo";
import {
  AldeaTranscribeAudioRepo,
  AssemblyAITranscribeAudioRepo,
  AzureTranscribeAudioRepo,
  BaseTranscribeAudioRepo,
  DeepgramTranscribeAudioRepo,
  ElevenLabsTranscribeAudioRepo,
  GladiaTranscribeAudioRepo,
  GeminiTranscribeAudioRepo,
  GroqTranscribeAudioRepo,
  LocalTranscribeAudioRepo,
  OpenAICompatibleTranscribeAudioRepo,
  OpenAITranscribeAudioRepo,
  OpenRouterTranscribeAudioRepo,
  SpeachesTranscribeAudioRepo,
  XaiTranscribeAudioRepo,
} from "./transcribe-audio.repo";
import {
  BaseTranscriptionRepo,
  LocalTranscriptionRepo,
} from "./transcription.repo";
import { BaseUserRepo, LocalUserRepo } from "./user.repo";
export { BaseModelProviderRepo } from "./model-provider.repo";

// The mausVoice Cloud backend (hosted AI, membership, billing) and the
// enterprise self-hosted gateway were both deprecated and removed in 0.1.6.
// Every repo factory now resolves to a local implementation.

export const getMemberRepo = (): BaseMemberRepo => {
  return new LocalMemberRepo();
};

export const getAuthRepo = (): BaseAuthRepo => {
  return new PersonalAuthRepo();
};

export const getUserRepo = (): BaseUserRepo => {
  return new LocalUserRepo();
};

export const getUserPreferencesRepo = (): BaseUserPreferencesRepo => {
  return new LocalUserPreferencesRepo();
};

export const getPairedRemoteDeviceRepo = (): BasePairedRemoteDeviceRepo => {
  return new LocalPairedRemoteDeviceRepo();
};

export const getRemoteReceiverRepo = (): BaseRemoteReceiverRepo => {
  return new LocalRemoteReceiverRepo();
};

export const getTranscriptionRepo = (): BaseTranscriptionRepo => {
  return new LocalTranscriptionRepo();
};

export const getAppTargetRepo = (): BaseAppTargetRepo => {
  return new LocalAppTargetRepo();
};

export const getTermRepo = (): BaseTermRepo => {
  return new LocalTermRepo();
};

export const getHotkeyRepo = (): BaseHotkeyRepo => {
  return new LocalHotkeyRepo();
};

export const getApiKeyRepo = (): BaseApiKeyRepo => {
  return new LocalApiKeyRepo();
};

export const getToneRepo = (): BaseToneRepo => {
  return new LocalToneRepo();
};

export const getStorageRepo = (): BaseStorageRepo => {
  return new LocalStorageRepo();
};

export const getConversationRepo = (): BaseConversationRepo => {
  return new LocalConversationRepo();
};

export const getChatMessageRepo = (): BaseChatMessageRepo => {
  return new LocalChatMessageRepo();
};

export const getToolRepo = (): ToolRepo => {
  return new ToolRepo();
};

export const getNativeRepo = (): BaseNativeRepo => {
  return new LocalNativeRepo();
};

export type GenerateTextRepoOutput = {
  repo: Nullable<BaseGenerateTextRepo>;
  apiKeyId: Nullable<string>;
  provider: Nullable<string>;
  warnings: string[];
};

const getGenTextRepoInternal = ({
  prefs,
}: {
  prefs: GenerativePrefs;
}): GenerateTextRepoOutput => {
  if (prefs.mode !== "api") {
    return {
      repo: null,
      apiKeyId: null,
      provider: null,
      warnings: prefs.warnings,
    };
  }

  const state = getAppState();
  const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);

  const builders: Partial<
    Record<
      ApiKeyProvider,
      (prefs: ApiGenerativePrefs) => BaseGenerateTextRepo | null
    >
  > = {
    ollama: (p) => {
      const baseUrl = apiKeyRecord?.baseUrl || OLLAMA_DEFAULT_URL;
      const model = p.postProcessingModel;
      const ollamaApiKey = apiKeyRecord?.keyFull || undefined;
      getLogger().verbose(
        `Configuring Ollama repo with baseUrl=${baseUrl} and model=${model}`,
      );
      if (!model) {
        p.warnings.push("No model configured for Ollama post-processing.");
        return null;
      }
      return new OllamaGenerateTextRepo(`${baseUrl}/v1`, model, ollamaApiKey);
    },
    "openai-compatible": (p) => {
      const baseUrl = apiKeyRecord?.baseUrl;
      const model = p.postProcessingModel;
      const providerApiKey = apiKeyRecord?.keyFull || undefined;
      const includeV1Path = apiKeyRecord?.includeV1Path;
      const fullUrl = buildOpenAICompatibleUrl(baseUrl, includeV1Path);
      getLogger().verbose(
        `Configuring OpenAI Compatible repo with baseUrl=${fullUrl} and model=${model}`,
      );
      if (!model) {
        p.warnings.push(
          "No model configured for OpenAI Compatible post-processing.",
        );
        return null;
      }
      return new OpenAICompatibleGenerateTextRepo(
        fullUrl,
        model,
        providerApiKey,
      );
    },
    openrouter: (p) => {
      const providerRouting =
        apiKeyRecord?.openRouterConfig?.providerRouting ?? undefined;
      getLogger().verbose(
        `Configuring OpenRouter repo with providerRouting=${providerRouting}`,
      );
      return new OpenRouterGenerateTextRepo(
        p.apiKeyValue,
        p.postProcessingModel,
        providerRouting,
      );
    },
    openai: (p) => {
      getLogger().verbose("Configuring OpenAI repo for generate text");
      return new OpenAIGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
    azure: (p) => {
      const endpoint = apiKeyRecord?.baseUrl || "";
      const deploymentName = p.postProcessingModel || "gpt-4o-mini";
      if (!endpoint) {
        p.warnings.push("No endpoint configured for Azure OpenAI.");
      }
      getLogger().verbose(
        `Configuring Azure OpenAI repo with endpoint=${endpoint} and deployment=${deploymentName}`,
      );
      return new AzureOpenAIGenerateTextRepo(
        p.apiKeyValue,
        endpoint,
        deploymentName,
      );
    },
    deepseek: (p) => {
      getLogger().verbose("Configuring Deepseek repo for generate text");
      return new DeepseekGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
    gemini: (p) => {
      getLogger().verbose("Configuring Gemini repo for generate text");
      return new GeminiGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
    claude: (p) => {
      getLogger().verbose("Configuring Claude repo for generate text");
      return new ClaudeGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
    cerebras: (p) => {
      getLogger().verbose("Configuring Cerebras repo for generate text");
      return new CerebrasGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
    groq: (p) => {
      getLogger().verbose("Configuring Groq repo for generate text");
      return new GroqGenerateTextRepo(p.apiKeyValue, p.postProcessingModel);
    },
  };

  const build = builders[prefs.provider] ?? builders.groq;
  return {
    repo: build ? build(prefs) : null,
    apiKeyId: prefs.apiKeyId,
    // Record the provider the builder was selected for, even when the
    // builder fell back to Groq, so history attribution matches the user's
    // selection rather than the silent fallback.
    provider: prefs.provider,
    warnings: prefs.warnings,
  };
};

export const getGenerateTextRepo = (): GenerateTextRepoOutput => {
  const prefs = getGenerativePrefs(getAppState());
  return getGenTextRepoInternal({ prefs });
};

export const getAgentRepo = (): GenerateTextRepoOutput => {
  const prefs = getAgentModePrefs(getAppState());
  if (prefs.mode === "openclaw") {
    throw new Error("OpenClaw provides its own LLM processor");
  }

  return getGenTextRepoInternal({ prefs });
};

export type TranscribeAudioRepoOutput = {
  repo: BaseTranscribeAudioRepo;
  apiKeyId: Nullable<string>;
  warnings: string[];
};

export const getTranscribeAudioRepo = (): TranscribeAudioRepoOutput => {
  const prefs = getTranscriptionPrefs(getAppState());

  if (prefs.mode === "api") {
    let repo: BaseTranscribeAudioRepo;
    let apiKeyId = prefs.apiKeyId;

    switch (prefs.provider) {
      case "openai":
        repo = new OpenAITranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "assemblyai":
        repo = new AssemblyAITranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "aldea":
        repo = new AldeaTranscribeAudioRepo(prefs.apiKeyValue);
        break;
      case "azure": {
        const state = getAppState();
        const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
        const region = apiKeyRecord?.azureRegion || "eastus";
        repo = new AzureTranscribeAudioRepo(prefs.apiKeyValue, region);
        break;
      }
      case "gemini":
        repo = new GeminiTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "openai-compatible": {
        const state = getAppState();
        const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
        const baseUrl = apiKeyRecord?.baseUrl;
        const model = prefs.transcriptionModel || "whisper-1";
        const providerApiKey = apiKeyRecord?.keyFull || undefined;
        const includeV1Path = apiKeyRecord?.includeV1Path;
        const fullUrl = buildOpenAICompatibleUrl(baseUrl, includeV1Path);
        if (!apiKeyRecord) {
          throw new Error(
            "OpenAI-compatible endpoint configuration is missing.",
          );
        }
        repo = new OpenAICompatibleTranscribeAudioRepo(
          apiKeyRecord.id,
          fullUrl,
          model,
          providerApiKey,
        );
        break;
      }
      case "speaches": {
        const state = getAppState();
        const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
        const baseUrl = apiKeyRecord?.baseUrl || "http://localhost:8000";
        const configuredModel = prefs.transcriptionModel;
        if (!configuredModel) {
          prefs.warnings.push(
            "No model configured for Speaches transcription.",
          );
        }
        repo = new SpeachesTranscribeAudioRepo(
          baseUrl,
          configuredModel || "Systran/faster-whisper-large-v3",
        );
        break;
      }
      case "elevenlabs":
        repo = new ElevenLabsTranscribeAudioRepo(prefs.apiKeyValue);
        break;
      case "deepgram":
        repo = new DeepgramTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "gladia":
        repo = new GladiaTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
          buildGladiaCustomizations(collectDictionaryEntries(getAppState())),
        );
        break;
      case "xai":
        repo = new XaiTranscribeAudioRepo(prefs.apiKeyValue);
        break;
      case "groq":
        repo = new GroqTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "openrouter":
        if (!prefs.transcriptionModel) {
          prefs.warnings.push(
            "No model configured for OpenRouter transcription.",
          );
        }
        repo = new OpenRouterTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      default: {
        // Every provider surfaced by the transcription capability filter now
        // has an explicit branch above. Reaching here means a stale saved
        // selection for a generative-only provider (e.g. an Ollama record
        // saved before the capability fix). Only fall back to Groq when a
        // configured Groq key exists — the stale selection's own key may be
        // empty or belong to another provider — and only warn when the
        // fallback actually happens; otherwise throw so the caller surfaces
        // the missing-key configuration instead of a dead warning.
        const state = getAppState();
        const groqRecord = Object.values(state.apiKeyById).find(
          (record) => record?.provider === "groq" && Boolean(record.keyFull),
        );
        if (!groqRecord?.keyFull) {
          throw new Error(
            `No transcription implementation for provider "${prefs.provider}" and no Groq API key is configured for fallback transcription.`,
          );
        }
        prefs.warnings.push(
          `No transcription implementation for provider "${prefs.provider}". Using the Groq repository as a fallback.`,
        );
        apiKeyId = groqRecord.id;
        // Use the Groq record's own transcription model (falling back to the
        // Groq repository default when unset) — never the stale selection's
        // model, which may belong to another provider and would be rejected.
        repo = new GroqTranscribeAudioRepo(
          groqRecord.keyFull,
          groqRecord.transcriptionModel ?? null,
        );
        break;
      }
    }

    return {
      repo,
      apiKeyId,
      warnings: prefs.warnings,
    };
  }

  return {
    repo: new LocalTranscribeAudioRepo(),
    apiKeyId: null,
    warnings: prefs.warnings,
  };
};

export const getModelProviderRepo = (
  provider: ApiKeyProvider,
): BaseModelProviderRepo => {
  switch (provider) {
    case "groq":
      return new GroqModelProviderRepo();
    case "openai":
      return new OpenAIModelProviderRepo();
    case "claude":
      return new ClaudeModelProviderRepo();
    case "cerebras":
      return new CerebrasModelProviderRepo();
    case "deepseek":
      return new DeepSeekModelProviderRepo();
    case "gemini":
      return new GeminiModelProviderRepo();
    case "azure":
      return new AzureModelProviderRepo();
    case "ollama":
      return new OllamaModelProviderRepo();
    case "openai-compatible":
      return new OpenAICompatibleModelProviderRepo();
    case "speaches":
      return new SpeachesModelProviderRepo();
    case "openrouter":
      return new OpenRouterModelProviderRepo();
    case "aldea":
      return new AldeaModelProviderRepo();
    case "assemblyai":
      return new AssemblyAIModelProviderRepo();
    case "elevenlabs":
      return new ElevenLabsModelProviderRepo();
    case "deepgram":
      return new DeepgramModelProviderRepo();
    case "gladia":
      return new GladiaModelProviderRepo();
    case "xai":
      return new XaiModelProviderRepo();
  }
};

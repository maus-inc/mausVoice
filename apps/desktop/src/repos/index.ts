import type { ApiKeyProvider } from "@maus-inc/types";
import { Nullable } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import { OLLAMA_DEFAULT_URL } from "../utils/ollama.utils";
import { buildOpenAICompatibleUrl } from "../utils/openai-compatible.utils";
import {
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
  warnings: string[];
};

const getGenTextRepoInternal = ({
  prefs,
}: {
  prefs: GenerativePrefs;
}): GenerateTextRepoOutput => {
  const state = getAppState();

  if (prefs.mode === "api") {
    let repo: BaseGenerateTextRepo | null = null;

    if (prefs.provider === "ollama") {
      // Get Ollama-specific config from the API key
      const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
      const baseUrl = apiKeyRecord?.baseUrl || OLLAMA_DEFAULT_URL;
      const model = prefs.postProcessingModel;
      const ollamaApiKey = apiKeyRecord?.keyFull || undefined;
      getLogger().verbose(
        `Configuring Ollama repo with baseUrl=${baseUrl} and model=${model}`,
      );
      if (model) {
        repo = new OllamaGenerateTextRepo(`${baseUrl}/v1`, model, ollamaApiKey);
      } else {
        prefs.warnings.push("No model configured for Ollama post-processing.");
      }
    } else if (prefs.provider === "openai-compatible") {
      const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
      const baseUrl = apiKeyRecord?.baseUrl;
      const model = prefs.postProcessingModel;
      const providerApiKey = apiKeyRecord?.keyFull || undefined;
      const includeV1Path = apiKeyRecord?.includeV1Path;
      const fullUrl = buildOpenAICompatibleUrl(baseUrl, includeV1Path);
      getLogger().verbose(
        `Configuring OpenAI Compatible repo with baseUrl=${fullUrl} and model=${model}`,
      );
      if (model) {
        repo = new OpenAICompatibleGenerateTextRepo(
          fullUrl,
          model,
          providerApiKey,
        );
      } else {
        prefs.warnings.push(
          "No model configured for OpenAI Compatible post-processing.",
        );
      }
    } else if (prefs.provider === "openrouter") {
      // Get OpenRouter-specific config from the API key
      const apiKey = getRec(state.apiKeyById, prefs.apiKeyId);
      const config = apiKey?.openRouterConfig;
      const providerRouting = config?.providerRouting ?? undefined;
      getLogger().verbose(
        `Configuring OpenRouter repo with providerRouting=${providerRouting}`,
      );
      repo = new OpenRouterGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
        providerRouting,
      );
    } else if (prefs.provider === "openai") {
      getLogger().verbose("Configuring OpenAI repo for generate text");
      repo = new OpenAIGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    } else if (prefs.provider === "azure") {
      const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
      const endpoint = apiKeyRecord?.baseUrl || "";
      const deploymentName = prefs.postProcessingModel || "gpt-4o-mini";
      if (!endpoint) {
        prefs.warnings.push("No endpoint configured for Azure OpenAI.");
      }
      getLogger().verbose(
        `Configuring Azure OpenAI repo with endpoint=${endpoint} and deployment=${deploymentName}`,
      );
      repo = new AzureOpenAIGenerateTextRepo(
        prefs.apiKeyValue,
        endpoint,
        deploymentName,
      );
    } else if (prefs.provider === "deepseek") {
      getLogger().verbose("Configuring Deepseek repo for generate text");
      repo = new DeepseekGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    } else if (prefs.provider === "gemini") {
      getLogger().verbose("Configuring Gemini repo for generate text");
      repo = new GeminiGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    } else if (prefs.provider === "claude") {
      getLogger().verbose("Configuring Claude repo for generate text");
      repo = new ClaudeGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    } else if (prefs.provider === "cerebras") {
      getLogger().verbose("Configuring Cerebras repo for generate text");
      repo = new CerebrasGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    } else {
      getLogger().verbose("Configuring Groq repo for generate text");
      repo = new GroqGenerateTextRepo(
        prefs.apiKeyValue,
        prefs.postProcessingModel,
      );
    }

    return {
      repo,
      apiKeyId: prefs.apiKeyId,
      warnings: prefs.warnings,
    };
  }

  return { repo: null, apiKeyId: null, warnings: prefs.warnings };
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
        repo = new AssemblyAITranscribeAudioRepo(prefs.apiKeyValue);
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
        const transcriptionPath = apiKeyRecord?.transcriptionPath ?? undefined;
        const fullUrl = buildOpenAICompatibleUrl(baseUrl, includeV1Path);
        repo = new OpenAICompatibleTranscribeAudioRepo(
          fullUrl,
          model,
          providerApiKey,
          transcriptionPath,
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
      case "xai":
        repo = new XaiTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "groq":
        repo = new GroqTranscribeAudioRepo(
          prefs.apiKeyValue,
          prefs.transcriptionModel,
        );
        break;
      case "openrouter": {
        const configuredModel = prefs.transcriptionModel;
        if (!configuredModel) {
          prefs.warnings.push(
            "No model configured for OpenRouter transcription.",
          );
        }
        repo = new OpenRouterTranscribeAudioRepo(
          prefs.apiKeyValue,
          configuredModel || "openai/whisper-1",
        );
        break;
      }
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
    case "xai":
      return new XaiModelProviderRepo();
  }
};

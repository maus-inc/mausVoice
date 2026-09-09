import { toLocalPreferences } from "../repos/preferences.repo";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  createPreviewScenario,
  isPreviewScenarioId,
  scenarioForPath,
  type PreviewData,
  type PreviewScenarioId,
} from "./scenarios";

/**
 * Error returned when a page asks the browser preview to perform a privileged
 * desktop operation. Keeping this explicit is safer than implying that audio,
 * accessibility, files, or external programs were touched.
 */
export class PreviewOperationError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(
      `“${command}” is unavailable in the browser preview. It requires the native mausVoice desktop app.`,
    );
    this.name = "PreviewOperationError";
    this.command = command;
  }
}

type WireRecord = Record<string, unknown>;
type PreviewDatabase = {
  user: WireRecord | null;
  preferences: WireRecord | null;
  terms: Map<string, WireRecord>;
  apiKeys: Map<string, WireRecord>;
  tones: Map<string, WireRecord>;
  hotkeys: Map<string, WireRecord>;
  appTargets: Map<string, WireRecord>;
  transcriptions: Map<string, WireRecord>;
  conversations: Map<string, WireRecord>;
  chatMessages: Map<string, WireRecord>;
  receiverEnabled: boolean;
};

const clone = <T>(value: T): T => structuredClone(value);
const asRecord = (value: unknown): WireRecord => value as WireRecord;
const asId = (value: unknown): string => String(value);

const toLocalUser = (user: NonNullable<PreviewData["user"]>): WireRecord => ({
  id: LOCAL_USER_ID,
  name: user.name,
  bio: user.bio ?? "",
  company: user.company ?? null,
  title: user.title ?? null,
  onboarded: user.onboarded,
  preferredMicrophone: user.preferredMicrophone ?? null,
  preferredLanguage: user.preferredLanguage ?? null,
  wordsThisMonth: user.wordsThisMonth,
  wordsThisMonthMonth: user.wordsThisMonthMonth ?? null,
  wordsTotal: user.wordsTotal,
  playInteractionChime: user.playInteractionChime,
  interactionFeedbackVolume: user.interactionFeedbackVolume ?? null,
  hasFinishedTutorial: user.hasFinishedTutorial,
  cohort: user.cohort ?? null,
  stylingMode: user.stylingMode ?? null,
  selectedToneId: user.selectedToneId ?? null,
  activeToneIds: user.activeToneIds ? JSON.stringify(user.activeToneIds) : null,
  streak: user.streak ?? null,
  streakRecordedAt: user.streakRecordedAt ?? null,
  referralSource: user.referralSource ?? null,
});

const toLocalTerm = (term: PreviewData["terms"][number]): WireRecord => ({
  id: term.id,
  createdAt: new Date(term.createdAt).valueOf(),
  createdByUserId: LOCAL_USER_ID,
  sourceValue: term.sourceValue,
  destinationValue: term.destinationValue,
  isReplacement: term.isReplacement,
  isDeleted: false,
});

const toLocalTone = (tone: PreviewData["customTones"][number]): WireRecord => ({
  id: tone.id,
  name: tone.name,
  promptTemplate: tone.promptTemplate,
  createdAt: tone.createdAt,
  sortOrder: tone.sortOrder,
  category: tone.category ?? null,
  outputLength: tone.outputLength ?? null,
  exampleInputOutput: tone.exampleInputOutput ?? null,
});

const toLocalApiKey = (apiKey: PreviewData["apiKeys"][number]): WireRecord => ({
  id: apiKey.id,
  name: apiKey.name,
  provider: apiKey.provider,
  createdAt: new Date(apiKey.createdAt).valueOf(),
  keySuffix: apiKey.keySuffix ?? null,
  keyFull: apiKey.keyFull ?? null,
  transcriptionModel: apiKey.transcriptionModel ?? null,
  postProcessingModel: apiKey.postProcessingModel ?? null,
  openrouterConfig: apiKey.openRouterConfig
    ? JSON.stringify(apiKey.openRouterConfig)
    : null,
  baseUrl: apiKey.baseUrl ?? null,
  azureRegion: apiKey.azureRegion ?? null,
  includeV1Path: apiKey.includeV1Path ?? null,
  transcriptionPath: apiKey.transcriptionPath ?? null,
});

const toLocalTranscription = (
  transcription: PreviewData["transcriptions"][number],
): WireRecord => ({
  id: transcription.id,
  transcript: transcription.transcript,
  timestamp: new Date(transcription.createdAt).valueOf(),
  audio: transcription.audio ?? null,
  modelSize: transcription.modelSize ?? null,
  inferenceDevice: transcription.inferenceDevice ?? null,
  rawTranscript: transcription.rawTranscript ?? null,
  sanitizedTranscript: transcription.sanitizedTranscript ?? null,
  transcriptionPrompt: transcription.transcriptionPrompt ?? null,
  postProcessPrompt: transcription.postProcessPrompt ?? null,
  transcriptionApiKeyId: transcription.transcriptionApiKeyId ?? null,
  postProcessApiKeyId: transcription.postProcessApiKeyId ?? null,
  transcriptionMode: transcription.transcriptionMode ?? null,
  postProcessMode: transcription.postProcessMode ?? null,
  postProcessDevice: transcription.postProcessDevice ?? null,
  postProcessModel: transcription.postProcessModel ?? null,
  postProcessProvider: transcription.postProcessProvider ?? null,
  postProcessFailed: transcription.postProcessFailed ?? null,
  postProcessError: transcription.postProcessError ?? null,
  transcriptionDurationMs: transcription.transcriptionDurationMs ?? null,
  postprocessDurationMs: transcription.postprocessDurationMs ?? null,
  warnings: transcription.warnings ?? null,
  remoteStatus: transcription.remoteStatus ?? null,
  remoteDeviceId: transcription.remoteDeviceId ?? null,
});

const toLocalConversation = (
  conversation: PreviewData["conversations"][number],
): WireRecord => ({
  ...conversation,
  createdAt: new Date(conversation.createdAt).valueOf(),
  updatedAt: new Date(conversation.updatedAt).valueOf(),
});

const toLocalChatMessage = (
  message: PreviewData["chatMessages"][number],
): WireRecord => ({
  ...message,
  createdAt: new Date(message.createdAt).valueOf(),
  metadata: message.metadata ? JSON.stringify(message.metadata) : null,
});

const toDatabase = (data: PreviewData): PreviewDatabase => ({
  user: data.user ? toLocalUser(data.user) : null,
  preferences: data.preferences
    ? asRecord(toLocalPreferences(data.preferences))
    : null,
  terms: new Map(data.terms.map((term) => [term.id, toLocalTerm(term)])),
  apiKeys: new Map(data.apiKeys.map((key) => [key.id, toLocalApiKey(key)])),
  tones: new Map(data.customTones.map((tone) => [tone.id, toLocalTone(tone)])),
  hotkeys: new Map(
    data.hotkeys.map((hotkey) => [hotkey.id, clone(hotkey) as WireRecord]),
  ),
  appTargets: new Map(
    data.appTargets.map((target) => [target.id, clone(target) as WireRecord]),
  ),
  transcriptions: new Map(
    data.transcriptions.map((transcription) => [
      transcription.id,
      toLocalTranscription(transcription),
    ]),
  ),
  conversations: new Map(
    data.conversations.map((conversation) => [
      conversation.id,
      toLocalConversation(conversation),
    ]),
  ),
  chatMessages: new Map(
    data.chatMessages.map((message) => [
      message.id,
      toLocalChatMessage(message),
    ]),
  ),
  receiverEnabled: false,
});

const getList = (records: Map<string, WireRecord>): WireRecord[] =>
  [...records.values()].map(clone);

const iconSvg = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="18" fill="#6264a7"/><path d="M18 30h44v22H18z" fill="#fff" opacity=".9"/><circle cx="30" cy="41" r="5" fill="#6264a7"/></svg>',
);

class PreviewRuntime {
  private database: PreviewDatabase = toDatabase(
    createPreviewScenario("populated").data,
  );
  private scenario: PreviewScenarioId = "populated";

  reset(scenario: PreviewScenarioId): void {
    const snapshot = createPreviewScenario(scenario);
    this.scenario = scenario;
    this.database = toDatabase(snapshot.data);
    // Replace every volatile branch, preserving no content from a previous
    // scenario. The Zustand persistence layer only stores `local`, which uses
    // the dedicated preview storage key.
    setAppState(clone(snapshot.state), true);
  }

  getScenario(): PreviewScenarioId {
    return this.scenario;
  }

  async invoke(command: string, args: WireRecord = {}): Promise<unknown> {
    switch (command) {
      case "user_get_one":
        return clone(this.database.user);
      case "user_set_one":
        this.database.user = clone(asRecord(args.user));
        return clone(this.database.user);
      case "user_preferences_get":
        return clone(this.database.preferences);
      case "user_preferences_set":
        this.database.preferences = clone(asRecord(args.preferences));
        return clone(this.database.preferences);

      case "term_list":
        return getList(this.database.terms).filter(
          (term) => term.isDeleted !== true,
        );
      case "term_create":
      case "term_update": {
        const term = clone(asRecord(args.term));
        this.database.terms.set(asId(term.id), term);
        return clone(term);
      }
      case "term_delete": {
        const term = this.database.terms.get(asId(args.id));
        if (term) term.isDeleted = true;
        return undefined;
      }

      case "tone_list":
        return getList(this.database.tones);
      case "tone_get":
        return clone(this.database.tones.get(asId(args.id)) ?? null);
      case "tone_upsert": {
        const tone = clone(asRecord(args.tone));
        this.database.tones.set(asId(tone.id), tone);
        return clone(tone);
      }
      case "tone_delete":
        this.database.tones.delete(asId(args.id));
        return undefined;

      case "hotkey_list":
        return getList(this.database.hotkeys);
      case "hotkey_save": {
        const hotkey = clone(asRecord(args.hotkey));
        this.database.hotkeys.set(asId(hotkey.id), hotkey);
        return clone(hotkey);
      }
      case "hotkey_delete":
        this.database.hotkeys.delete(asId(args.id));
        return undefined;
      case "hotkey_replace_style_hotkeys": {
        const prefix = String(args.prefix ?? "");
        for (const [id, hotkey] of this.database.hotkeys) {
          if (String(hotkey.actionName).startsWith(prefix)) {
            this.database.hotkeys.delete(id);
          }
        }
        const hotkeys = (args.hotkeys as WireRecord[]).map(clone);
        for (const hotkey of hotkeys)
          this.database.hotkeys.set(asId(hotkey.id), hotkey);
        return clone(hotkeys);
      }

      case "api_key_list":
        return getList(this.database.apiKeys);
      case "api_key_create": {
        const metadata = clone(asRecord(args.apiKey));
        delete metadata.key;
        const apiKey: WireRecord = {
          ...metadata,
          createdAt: Date.now(),
          // The preview must not retain secrets pasted into a UI experiment.
          keySuffix: "…preview",
          keyFull: null,
          transcriptionModel: null,
          postProcessingModel: null,
          openrouterConfig: null,
        };
        this.database.apiKeys.set(asId(apiKey.id), apiKey);
        return clone(apiKey);
      }
      case "api_key_update": {
        const request = asRecord(args.request);
        const previous = this.database.apiKeys.get(asId(request.id));
        if (!previous) throw new Error("API key not found.");
        const metadata = clone(request);
        const keyWasProvided = typeof metadata.key === "string";
        delete metadata.key;
        const apiKey = { ...previous, ...metadata };
        if (keyWasProvided) {
          // Do not keep an entered secret in the preview's mock transport.
          apiKey.keyFull = null;
          apiKey.keySuffix = "…preview";
        }
        this.database.apiKeys.set(asId(apiKey.id), apiKey);
        return clone(apiKey);
      }
      case "api_key_delete":
        this.database.apiKeys.delete(asId(args.id));
        return undefined;

      case "app_target_list":
        return getList(this.database.appTargets);
      case "app_target_upsert": {
        const target: WireRecord = {
          ...asRecord(args.args),
          createdAt: new Date().toISOString(),
        };
        this.database.appTargets.set(asId(target.id), target);
        return clone(target);
      }

      case "transcription_list": {
        const limit = Number(args.limit ?? 20);
        const offset = Number(args.offset ?? 0);
        return getList(this.database.transcriptions)
          .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
          .slice(offset, offset + limit);
      }
      case "transcription_create":
      case "transcription_update": {
        const transcription = clone(asRecord(args.transcription));
        this.database.transcriptions.set(asId(transcription.id), transcription);
        return clone(transcription);
      }
      case "transcription_delete":
        this.database.transcriptions.delete(asId(args.id));
        return undefined;
      case "transcription_load_audio":
        return {
          samples: Array.from({ length: 800 }, () => 0),
          sampleRate: 16_000,
        };
      case "transcription_import_audio":
        // There is no privileged OS file picker in a web preview. Returning
        // null follows the native cancellation contract without pretending a
        // local file was read.
        return null;
      case "purge_stale_transcription_audio":
        return [];

      case "conversation_list":
        return getList(this.database.conversations).sort(
          (a, b) => Number(b.updatedAt) - Number(a.updatedAt),
        );
      case "conversation_create":
      case "conversation_update": {
        const conversation = clone(asRecord(args.conversation));
        this.database.conversations.set(asId(conversation.id), conversation);
        return clone(conversation);
      }
      case "conversation_delete":
        this.database.conversations.delete(asId(args.id));
        for (const [id, message] of this.database.chatMessages) {
          if (message.conversationId === args.id)
            this.database.chatMessages.delete(id);
        }
        return undefined;
      case "chat_message_list":
        return getList(this.database.chatMessages)
          .filter((message) => message.conversationId === args.conversationId)
          .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
      case "chat_message_create":
      case "chat_message_update": {
        const message = clone(asRecord(args.message));
        this.database.chatMessages.set(asId(message.id), message);
        return clone(message);
      }
      case "chat_message_delete_many":
        for (const id of (args.ids as unknown[]) ?? []) {
          this.database.chatMessages.delete(asId(id));
        }
        return undefined;

      case "paired_remote_device_list":
        return [];
      case "paired_remote_device_upsert":
        return clone(asRecord(args.device));
      case "paired_remote_device_delete":
        return undefined;
      case "remote_receiver_status":
      case "remote_receiver_start":
      case "remote_receiver_stop": {
        if (command === "remote_receiver_start")
          this.database.receiverEnabled = true;
        if (command === "remote_receiver_stop")
          this.database.receiverEnabled = false;
        return {
          enabled: this.database.receiverEnabled,
          deviceId: "preview-browser",
          deviceName: "Browser preview",
          devicePlatform: "macos",
          listenAddress: null,
          port: null,
          pairingCode: "PREVIEW",
          lastSenderDeviceId: null,
          lastEventId: null,
          lastDeliveryStatus: null,
          lastDeliveryAt: null,
          lastError: null,
          lastTargetClassName: null,
          lastTargetTitle: null,
          lastTargetEditable: null,
        };
      }
      case "remote_sender_deliver_final_text":
        return undefined;

      // Safe, deterministic desktop-information and configuration responses.
      case "check_microphone_permission":
        return clone(getAppState().permissions.microphone);
      case "check_accessibility_permission":
        return clone(getAppState().permissions.accessibility);
      case "request_microphone_permission":
        return { kind: "microphone", state: "authorized", promptShown: true };
      case "request_accessibility_permission":
        return {
          kind: "accessibility",
          state: "authorized",
          promptShown: true,
        };
      case "get_version":
        return "0.1.6-preview";
      case "get_identifier":
        return "com.mausvoice.preview";
      case "get_hotkey_strategy":
        return "bridge";
      case "get_key_listener_health":
        return "healthy_grab";
      case "supports_app_detection":
        return true;
      case "supports_paste_keybinds":
        return "per-app";
      case "get_system_capabilities":
        return { ramGb: 8, cpuCores: 8, gpus: [] };
      case "get_system_volume":
        return 0.7;
      case "set_system_volume":
        return undefined;
      case "check_app_location_writable":
        return true;
      case "get_keyboard_language":
        return "en";
      case "list_microphones":
        return [
          {
            label: "Preview microphone",
            isDefault: true,
            caution: false,
          },
        ];
      case "list_gpus":
        return [];
      case "storage_get_download_url":
        return `data:image/svg+xml,${iconSvg}`;
      case "start_recording":
        return { sampleRate: 16_000 };
      case "stop_recording":
        return { samples: [], sampleRate: 16_000 };
      case "pause_recording":
      case "resume_recording":
      case "stop_key_listener":
      case "start_key_listener":
      case "restart_key_listener":
      case "reset_key_listener_state":
      case "sync_hotkey_combos":
      case "sync_compositor_hotkeys":
      case "set_dashboard_menu_labels":
      case "set_phase":
      case "set_pill_placement":
      case "set_pill_visibility":
      case "set_pill_visibility_menu_state":
      case "set_pill_window_size":
      case "set_register_app_label":
      case "set_reset_pill_position_enabled":
      case "set_menu_icon":
      case "set_tray_language_menu":
      case "set_tray_title":
      case "set_tray_visible":
      case "set_interaction_chime_enabled":
      case "set_interaction_feedback_volume":
      case "notify_pill_style_info":
      case "open_app_settings":
      case "show_in_folder":
      case "show_notification":
      case "set_auto_launch":
      case "restart_app":
      case "quit_app":
      case "reset_native_setup":
      case "retry_key_listener":
      case "remote_sender_disconnect":
        return undefined;
      case "run_native_setup":
        return "success";
      case "export_diagnostics":
      case "export_transcription":
        return true;
      default:
        throw new PreviewOperationError(command);
    }
  }
}

const runtime = new PreviewRuntime();

export const applyPreviewScenario = (scenario: PreviewScenarioId): void => {
  runtime.reset(scenario);
};

export const getActivePreviewScenario = (): PreviewScenarioId =>
  runtime.getScenario();

export const invokePreviewCommand = <T>(
  command: string,
  args?: WireRecord,
): Promise<T> => runtime.invoke(command, args).then((value) => value as T);

export const previewScenarioFromLocation = (
  location: Location,
): PreviewScenarioId => {
  const explicitScenario = new URLSearchParams(location.search).get("scenario");
  return isPreviewScenarioId(explicitScenario)
    ? explicitScenario
    : scenarioForPath(location.pathname);
};

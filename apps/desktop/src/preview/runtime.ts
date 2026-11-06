import { toLocalUser } from "../repos/user.repo";
import { toLocalPreferences } from "../repos/preferences.repo";
import { transcriptionWireFields } from "../repos/transcription-wire-fields";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { PreviewOperationError } from "./PreviewOperationError";
import {
  replaceDictationHotkeys,
  replaceStyleHotkeys,
} from "./hotkey-replacement";
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
 *
 * Defined in its own module so the low-level Tauri stubs can raise it without
 * importing this file, and re-exported here so there is still one import path
 * and `instanceof` keeps working for app code and the runtime's own tests.
 */
export { PreviewOperationError };

/**
 * System commands the preview accepts and answers with `undefined`.
 *
 * They are the write-side and lifecycle commands a page fires to make the
 * desktop look busy: pausing a recording, moving the pill, quitting, opening a
 * folder. None of them can be honoured without the native app, and none of them
 * reports a value, so `invokeSystem` answers them from this list rather than
 * spending a `case` arm apiece. A command that is NOT here and returns nothing
 * useful either is a privileged operation, and still raises
 * `PreviewOperationError` — this list is an acknowledgement set, not a
 * silent-success catch-all.
 */
const SYSTEM_NO_OP_COMMANDS = new Set([
  "notify_pill_style_info",
  "open_app_settings",
  "quit_app",
  "remote_sender_disconnect",
  "reset_key_listener_state",
  "reset_native_setup",
  "restart_app",
  "restart_key_listener",
  "retry_key_listener",
  "set_auto_launch",
  "set_dashboard_menu_labels",
  "set_interaction_chime_enabled",
  "set_interaction_feedback_volume",
  "set_menu_icon",
  "set_phase",
  "set_pill_placement",
  "set_pill_visibility",
  "set_pill_visibility_menu_state",
  "set_pill_window_size",
  "set_register_app_label",
  "set_system_volume",
  "set_reset_pill_position_enabled",
  "set_tray_language_menu",
  "set_tray_title",
  "set_tray_visible",
  "show_in_folder",
  "show_notification",
  "start_key_listener",
  "stop_key_listener",
  "sync_compositor_hotkeys",
  "sync_hotkey_combos",
]);

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

/** Provider endpoint options use the native API's nullable wire representation. */
const apiKeyEndpointFields = (apiKey: PreviewData["apiKeys"][number]) => ({
  baseUrl: apiKey.baseUrl ?? null,
  azureRegion: apiKey.azureRegion ?? null,
  includeV1Path: apiKey.includeV1Path ?? null,
  transcriptionPath: apiKey.transcriptionPath ?? null,
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
  openRouterConfig: apiKey.openRouterConfig
    ? JSON.stringify(apiKey.openRouterConfig)
    : null,
  ...apiKeyEndpointFields(apiKey),
});

const toLocalTranscription = (
  transcription: PreviewData["transcriptions"][number],
): WireRecord => ({
  id: transcription.id,
  transcript: transcription.transcript,
  timestamp: new Date(transcription.createdAt).valueOf(),
  audio: transcription.audio ?? null,
  ...transcriptionWireFields(transcription),
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

/**
 * The nullable `api_key_update` columns, in the wire casing the request uses.
 * Each one is written through `CASE WHEN ?n IS NOT NULL THEN ?n ELSE <column>
 * END` on the desktop, so a request that omits the key, or sends it as null,
 * leaves the stored value untouched.
 */
const NULL_GUARDED_API_KEY_FIELDS = [
  "name",
  "keySuffix",
  "transcriptionModel",
  "postProcessingModel",
  "openRouterConfig",
  "baseUrl",
  "azureRegion",
  "includeV1Path",
] as const;

const iconSvg = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="18" fill="#6264a7"/><path d="M18 30h44v22H18z" fill="#fff" opacity=".9"/><circle cx="30" cy="41" r="5" fill="#6264a7"/></svg>',
);

/** Deterministic system replies; clone before returning so callers cannot mutate the fixtures. */
const SYSTEM_RESPONSES = new Map<string, unknown>([
  [
    "request_microphone_permission",
    { kind: "microphone", state: "authorized", promptShown: true },
  ],
  [
    "request_accessibility_permission",
    { kind: "accessibility", state: "authorized", promptShown: true },
  ],
  ["get_version", "0.1.6-preview"],
  ["get_identifier", "com.mausvoice.preview"],
  ["get_hotkey_strategy", "bridge"],
  ["get_key_listener_health", "healthy_grab"],
  ["supports_app_detection", true],
  ["supports_paste_keybinds", "per-app"],
  ["get_system_capabilities", { ramGb: 8, cpuCores: 8, gpus: [] }],
  ["get_system_volume", 0.7],
  ["check_app_location_writable", true],
  ["get_keyboard_language", "en"],
  [
    "list_microphones",
    [{ label: "Preview microphone", isDefault: true, caution: false }],
  ],
  ["list_gpus", []],
  ["storage_get_download_url", `data:image/svg+xml,${iconSvg}`],
  ["run_native_setup", "success"],
  ["export_diagnostics", true],
  ["export_transcription", true],
]);

const parseExpansionFlagInput = (
  args: WireRecord,
  compare: boolean,
): { flags: string; expected: unknown } => {
  const input = asRecord(args.args);
  const flags = input?.flags;
  const expected = input?.expected;
  if (typeof flags !== "string" || (compare && typeof expected !== "string")) {
    throw new TypeError("Expected string expansion flag arguments");
  }
  return { flags, expected };
};

/** Returned by a command group that does not handle the command. */
const UNHANDLED = Symbol("preview-unhandled");

class PreviewRuntime {
  private recordingOwner: string | null = null;
  private recordingOwnerToken: number | null = null;
  private recordingIsExternal = false;
  private recordingGeneration = 0;
  private nextRecordingToken = 0;
  private readonly recordingAdmissions = new Map<
    string,
    { generation: number; epoch: number; claimed: boolean }
  >();
  private readonly recordingResults = new Map<
    number,
    { ownerId: string; created: number; replays: number }
  >();
  private readonly recordingWaiters = new Set<() => void>();
  private database: PreviewDatabase = toDatabase(
    createPreviewScenario("populated").data,
  );
  private scenario: PreviewScenarioId = "populated";

  reset(scenario: PreviewScenarioId): void {
    if (!this.recordingIsExternal) {
      this.recordingOwner = null;
      this.recordingOwnerToken = null;
    }
    this.recordingGeneration += 1;
    this.recordingAdmissions.clear();
    this.recordingResults.clear();
    this.notifyRecordingWaiters();
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

  /**
   * Applies the same omit-versus-clear semantics the desktop statement uses, so
   * the preview cannot diverge from the real transport on a column the caller
   * never mentioned.
   */
  private updateApiKey(args: WireRecord): WireRecord {
    const request = asRecord(args.request);
    const previous = this.database.apiKeys.get(String(request.id));
    if (!previous) throw new Error("API key not found.");
    // The desktop statement writes every nullable column through
    // `CASE WHEN ?n IS NOT NULL THEN ?n ELSE <column> END`, so a missing or
    // null field means "leave what is stored alone". Spreading the raw request
    // would instead wipe a value the caller never mentioned.
    const apiKey: WireRecord = { ...previous };
    for (const field of NULL_GUARDED_API_KEY_FIELDS) {
      const value = request[field];
      if (value !== null && value !== undefined) {
        apiKey[field] = value;
      }
    }
    if (typeof request.key === "string") {
      // Do not keep an entered secret in the preview's mock transport.
      apiKey.keyFull = null;
      apiKey.keySuffix = "…preview";
    }
    // `transcription_path` is the one column the desktop statement gates on a
    // separate boolean rather than on null, so it keeps its own handling.
    // `update_api_key` computes the stored value before the statement runs: an
    // explicit `clear_transcription_path` of true wins outright, a supplied
    // path is trimmed and an empty or whitespace-only result clears the
    // column, and a path that was never mentioned leaves the column alone.
    if (request.clearTranscriptionPath === true) {
      apiKey.transcriptionPath = null;
    } else if (typeof request.transcriptionPath === "string") {
      const trimmed = request.transcriptionPath.trim();
      apiKey.transcriptionPath = trimmed === "" ? null : trimmed;
    }
    this.database.apiKeys.set(String(apiKey.id), apiKey);
    return clone(apiKey);
  }

  /**
   * Mirrors Tauri's `invoke`, which is always promise-returning, so this keeps a
   * promise signature even though the mock dispatch below is synchronous:
   * `invokePreviewCommand` chains `.then(...)` and pages `await` the result.
   * Deferring the dispatch is also what keeps a rejected command an async
   * rejection rather than a synchronous throw.
   */
  invoke(command: string, args: WireRecord = {}): Promise<unknown> {
    return Promise.resolve().then(() => this.dispatch(command, args));
  }

  private dispatch(command: string, args: WireRecord): unknown {
    if (command.startsWith("user_")) return this.invokeUser(command, args);
    if (command.startsWith("term_")) return this.invokeTerms(command, args);
    if (command.startsWith("tone_")) return this.invokeTones(command, args);
    if (command.startsWith("hotkey_")) return this.invokeHotkeys(command, args);
    if (command.startsWith("api_key_"))
      return this.invokeApiKeys(command, args);
    if (command.startsWith("app_target_"))
      return this.invokeAppTargets(command, args);
    return this.invokeHistory(command, args);
  }

  private invokeUser(command: string, args: WireRecord): unknown {
    switch (command) {
      case "user_get_one":
        return clone(this.database.user);
      case "user_set_one":
        this.database.user = clone(asRecord(args.user));
        return clone(this.database.user);
      case "user_preferences_get":
        return clone(this.database.preferences);
      case "user_preferences_set": {
        const next = clone(asRecord(args.preferences));
        if (this.database.preferences) {
          next.expansionFlags = this.database.preferences.expansionFlags;
        }
        this.database.preferences = next;
        return clone(next);
      }
      case "user_preferences_set_expansion_flags":
        return this.updateExpansionFlags(args, false);
      case "user_preferences_compare_set_expansion_flags":
        return this.updateExpansionFlags(args, true);

      default:
        return this.invokeHistory(command, args);
    }
  }

  private invokeTerms(command: string, args: WireRecord): unknown {
    switch (command) {
      case "term_list":
        return getList(this.database.terms).filter(
          (term) => term.isDeleted !== true,
        );
      case "term_create":
      case "term_update": {
        const term = clone(asRecord(args.term));
        this.database.terms.set(String(term.id), term);
        return clone(term);
      }
      case "term_delete": {
        const term = this.database.terms.get(String(args.id));
        if (term) term.isDeleted = true;
        return undefined;
      }

      default:
        return this.invokeHistory(command, args);
    }
  }

  private invokeTones(command: string, args: WireRecord): unknown {
    switch (command) {
      case "tone_list":
        return getList(this.database.tones);
      case "tone_get":
        return clone(this.database.tones.get(String(args.id)) ?? null);
      case "tone_upsert": {
        const tone = clone(asRecord(args.tone));
        this.database.tones.set(String(tone.id), tone);
        return clone(tone);
      }
      case "tone_delete":
        this.database.tones.delete(String(args.id));
        return undefined;

      default:
        return this.invokeHistory(command, args);
    }
  }

  private invokeHotkeys(command: string, args: WireRecord): unknown {
    switch (command) {
      case "hotkey_list":
        return getList(this.database.hotkeys);
      case "hotkey_save": {
        const hotkey = clone(asRecord(args.hotkey));
        this.database.hotkeys.set(String(hotkey.id), hotkey);
        return clone(hotkey);
      }
      case "hotkey_delete":
        this.database.hotkeys.delete(String(args.id));
        return undefined;
      case "hotkey_replace_style_hotkeys":
        return this.replaceStyleHotkeys(args);
      case "hotkey_replace_dictation_language_hotkeys":
        return this.replaceDictationLanguageHotkeys(args);

      default:
        return this.invokeHistory(command, args);
    }
  }

  private invokeApiKeys(command: string, args: WireRecord): unknown {
    switch (command) {
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
          openRouterConfig: null,
        };
        this.database.apiKeys.set(String(apiKey.id), apiKey);
        return clone(apiKey);
      }
      case "api_key_update":
        return this.updateApiKey(args);
      case "api_key_delete":
        this.database.apiKeys.delete(String(args.id));
        return undefined;

      default:
        return this.invokeHistory(command, args);
    }
  }

  private invokeAppTargets(command: string, args: WireRecord): unknown {
    switch (command) {
      case "app_target_list":
        return getList(this.database.appTargets);
      case "app_target_upsert": {
        const target: WireRecord = {
          ...asRecord(args.args),
          createdAt: new Date().toISOString(),
        };
        this.database.appTargets.set(String(target.id), target);
        return clone(target);
      }

      default:
        return this.invokeHistory(command, args);
    }
  }

  private updateExpansionFlags(
    args: WireRecord,
    compare: boolean,
  ): WireRecord | null {
    const { flags, expected } = parseExpansionFlagInput(args, compare);
    const preferences = this.database.preferences;
    if (!preferences) {
      if (compare) return null;
      throw new Error("Preferences not found");
    }
    if (compare && (preferences.expansionFlags ?? "{}") !== expected)
      return null;
    preferences.expansionFlags = flags;
    return clone(preferences);
  }

  private replaceDictationLanguageHotkeys(args: WireRecord): void {
    this.database.hotkeys = replaceDictationHotkeys(
      this.database.hotkeys,
      args,
    );
  }

  private replaceStyleHotkeys(args: WireRecord): WireRecord[] {
    const { next, hotkeys } = replaceStyleHotkeys(this.database.hotkeys, args);
    this.database.hotkeys = next;
    return hotkeys;
  }

  private invokeHistory(command: string, args: WireRecord): unknown {
    if (command.startsWith("chat_message_")) {
      return this.invokeChatMessages(command, args);
    }
    if (
      command.startsWith("transcription_audio_") ||
      command === "transcription_load_audio" ||
      command === "transcription_import_audio" ||
      command === "purge_stale_transcription_audio"
    ) {
      return this.invokeTranscriptionAudio(command, args);
    }
    if (command.startsWith("transcription_")) {
      return this.invokeTranscription(command, args);
    }
    return this.invokeConversations(command, args);
  }

  private invokeTranscription(command: string, args: WireRecord): unknown {
    switch (command) {
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
        this.database.transcriptions.set(
          String(transcription.id),
          transcription,
        );
        return clone(transcription);
      }
      case "transcription_delete":
        this.database.transcriptions.delete(String(args.id));
        return undefined;
      default:
        return this.invokeRemote(command, args);
    }
  }

  private invokeTranscriptionAudio(command: string, args: WireRecord): unknown {
    switch (command) {
      case "transcription_audio_load":
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

      default:
        return this.invokeRemote(command, args);
    }
  }

  private invokeConversations(command: string, args: WireRecord): unknown {
    switch (command) {
      case "conversation_list":
        return getList(this.database.conversations).sort(
          (a, b) => Number(b.updatedAt) - Number(a.updatedAt),
        );
      case "conversation_create":
      case "conversation_update": {
        const conversation = clone(asRecord(args.conversation));
        this.database.conversations.set(String(conversation.id), conversation);
        return clone(conversation);
      }
      case "conversation_delete":
        this.database.conversations.delete(String(args.id));
        for (const [id, message] of this.database.chatMessages) {
          if (message.conversationId === args.id)
            this.database.chatMessages.delete(id);
        }
        return undefined;
      default:
        return this.invokeRemote(command, args);
    }
  }

  private invokeChatMessages(command: string, args: WireRecord): unknown {
    switch (command) {
      case "chat_message_list":
        return getList(this.database.chatMessages)
          .filter((message) => message.conversationId === args.conversationId)
          .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
      case "chat_message_create":
      case "chat_message_update": {
        const message = clone(asRecord(args.message));
        this.database.chatMessages.set(String(message.id), message);
        return clone(message);
      }
      case "chat_message_delete_many":
        for (const id of (args.ids as unknown[]) ?? []) {
          this.database.chatMessages.delete(String(id));
        }
        return undefined;

      default:
        return this.invokeRemote(command, args);
    }
  }

  private invokeRemote(command: string, args: WireRecord): unknown {
    switch (command) {
      case "paired_remote_device_list":
        return [];
      case "paired_remote_device_upsert":
        // `paired-remote-device.repo.ts` sends `{ args: params }` and
        // `paired_remote_device_upsert` binds a parameter of that name, so the
        // device fields live under `args.args`. Reading `args.device` produced
        // undefined, and the pairing page in the browser preview could not show
        // the device it had just saved.
        return clone(asRecord(args.args));
      case "paired_remote_device_delete":
        return undefined;
      case "remote_receiver_status":
      case "remote_receiver_start":
      case "remote_receiver_stop":
        return this.invokeReceiver(command);

      case "remote_sender_deliver_final_text":
        return undefined;

      default:
        return this.invokeSystem(command, args);
    }
  }

  /** Return a fresh receiver snapshot after applying a lifecycle command. */
  private invokeReceiver(command: string): WireRecord {
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

  private notifyRecordingWaiters(): void {
    for (const wake of Array.from(this.recordingWaiters)) wake();
  }

  private waitForPreviewRecorder(
    args: WireRecord,
    admission: { generation: number; epoch: number; claimed: boolean },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.recordingWaiters.delete(wake);
      };
      const wake = () => {
        if (
          admission.epoch !== this.recordingGeneration ||
          this.recordingAdmissions.get(args.ownerId as string) !== admission
        ) {
          finish();
          reject(new Error("Recording start was cancelled"));
        } else if (this.recordingOwner === null) {
          finish();
          this.recordingOwner = args.ownerId as string;
          this.recordingOwnerToken = admission.generation;
          resolve({ sampleRate: 16_000 });
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error("A recording is already in progress"));
      }, 2_000);
      this.recordingWaiters.add(wake);
    });
  }

  private previewOwnerId(args: WireRecord): string {
    const id = args.ownerId;
    if (typeof id !== "string" || !id || id.length > 128)
      throw new Error("Invalid recording owner");
    return id;
  }

  private reservePreviewRecording(args: WireRecord): number {
    const id = this.previewOwnerId(args);
    if (this.recordingAdmissions.has(id))
      throw new Error("Recording owner is already admitted");
    if (this.nextRecordingToken >= Number.MAX_SAFE_INTEGER)
      throw new Error("Recording admission tokens are exhausted");
    const generation = ++this.nextRecordingToken;
    this.recordingAdmissions.set(id, {
      generation,
      epoch: this.recordingGeneration,
      claimed: false,
    });
    return generation;
  }

  private claimPreviewAdmission(args: WireRecord) {
    const ownerId = this.previewOwnerId(args);
    const admission = this.recordingAdmissions.get(ownerId);
    if (
      !admission ||
      admission.claimed ||
      admission.generation !== args.generation ||
      admission.epoch !== this.recordingGeneration
    )
      throw new Error("Recording start was cancelled");
    admission.claimed = true;
    return { ownerId, admission };
  }

  private startPreviewRecording(args: WireRecord): unknown {
    const { ownerId, admission } = this.claimPreviewAdmission(args);
    const finish = () => {
      if (this.recordingAdmissions.get(ownerId) === admission)
        this.recordingAdmissions.delete(ownerId);
    };
    if (this.recordingOwner !== null) {
      if (asRecord(args.args)?.waitForRelease === true)
        return this.waitForPreviewRecorder(args, admission).finally(finish);
      finish();
      throw new Error("A recording is already in progress");
    }
    this.recordingOwner = ownerId;
    this.recordingOwnerToken = admission.generation;
    finish();
    return { sampleRate: 16_000 };
  }

  private claimPreviewBrowserRecording(args: WireRecord): void {
    const { ownerId, admission } = this.claimPreviewAdmission(args);
    if (this.recordingAdmissions.get(ownerId) === admission)
      this.recordingAdmissions.delete(ownerId);
    if (this.recordingOwner !== null)
      throw new Error("A recording is already in progress");
    this.recordingOwner = ownerId;
    this.recordingOwnerToken = admission.generation;
    this.recordingIsExternal = true;
  }

  private releasePreviewBrowserRecording(args: WireRecord): void {
    if (typeof args.ownerId !== "string") return;
    if (
      this.recordingAdmissions.get(args.ownerId)?.generation === args.generation
    )
      this.recordingAdmissions.delete(args.ownerId);
    if (
      this.recordingIsExternal &&
      this.recordingOwner === args.ownerId &&
      this.recordingOwnerToken === args.generation
    ) {
      this.recordingOwner = null;
      this.recordingOwnerToken = null;
      this.recordingIsExternal = false;
    }
    this.notifyRecordingWaiters();
  }

  private discardPreviewRecording(args: WireRecord): void {
    if (typeof args.ownerId !== "string") return;
    if (
      typeof args.generation === "number" &&
      this.recordingResults.get(args.generation)?.ownerId === args.ownerId
    )
      this.recordingResults.delete(args.generation);
    if (
      this.recordingAdmissions.get(args.ownerId)?.generation === args.generation
    )
      this.recordingAdmissions.delete(args.ownerId);
    if (
      this.recordingOwner === args.ownerId &&
      this.recordingOwnerToken === args.generation
    ) {
      if (this.recordingIsExternal)
        throw new Error("Browser recording has not ended");
      this.recordingOwner = null;
      this.recordingOwnerToken = null;
    }
    this.notifyRecordingWaiters();
  }

  /** Drop replay copies past their retention window. */
  private pruneExpiredRecordingResults(): void {
    for (const [token, result] of this.recordingResults) {
      if (Date.now() - result.created >= 60_000)
        this.recordingResults.delete(token);
    }
  }

  /** Replay a retained copy once, bounded so a caller cannot loop forever. */
  private replayRecordedResult(args: WireRecord): unknown {
    const result =
      typeof args.generation === "number"
        ? this.recordingResults.get(args.generation)
        : undefined;
    if (!result || result.ownerId !== args.ownerId) return undefined;
    if (result.replays >= 4)
      throw new Error("Recording recovery replay limit reached");
    result.replays += 1;
    return { samples: [], sampleRate: 16_000 };
  }

  /**
   * A stop for an admission this session never claimed: release the reservation
   * instead of reporting ownership it does not have.
   */
  private releaseUnclaimedAdmission(args: WireRecord): unknown {
    if (
      typeof args.ownerId !== "string" ||
      (this.recordingOwner === args.ownerId &&
        this.recordingOwnerToken === args.generation) ||
      this.recordingAdmissions.get(args.ownerId)?.generation !== args.generation
    )
      return undefined;
    this.recordingAdmissions.delete(args.ownerId);
    this.notifyRecordingWaiters();
    return { samples: [], sampleRate: 0 };
  }

  private assertRecordingOwned(args: WireRecord): void {
    if (
      typeof args.ownerId !== "string" ||
      this.recordingOwner !== args.ownerId ||
      this.recordingOwnerToken !== args.generation ||
      this.recordingIsExternal
    )
      throw new Error("Recording is no longer owned by this session");
  }

  /** Retain this stop's audio for a later replay, within the replay budget. */
  private rememberRecordingResult(args: WireRecord): void {
    if (typeof args.generation === "number" && this.recordingResults.size < 8) {
      this.recordingResults.set(args.generation, {
        ownerId: this.recordingOwner as string,
        created: Date.now(),
        replays: 0,
      });
    }
  }

  private controlPreviewRecording(command: string, args: WireRecord): unknown {
    if (command === "stop_recording") {
      this.pruneExpiredRecordingResults();
      const replayed = this.replayRecordedResult(args);
      if (replayed) return replayed;
      const releasedAdmission = this.releaseUnclaimedAdmission(args);
      if (releasedAdmission) return releasedAdmission;
    }
    this.assertRecordingOwned(args);
    if (command !== "stop_recording") return undefined;
    this.rememberRecordingResult(args);
    this.recordingOwner = null;
    this.recordingOwnerToken = null;
    this.notifyRecordingWaiters();
    return { samples: [], sampleRate: 16_000 };
  }

  private invokeRecording(command: string, args: WireRecord): unknown {
    const lifecycle = this.invokeRecordingLifecycle(command, args);
    if (lifecycle !== UNHANDLED) return lifecycle;
    const browser = this.invokeBrowserRecording(command, args);
    if (browser !== UNHANDLED) return browser;
    return this.controlPreviewRecording(command, args);
  }

  /** Admission and start, which every other recording command builds on. */
  private invokeRecordingLifecycle(command: string, args: WireRecord): unknown {
    if (command === "recording_generation")
      return this.reservePreviewRecording(args);
    if (command === "start_recording") return this.startPreviewRecording(args);
    if (command !== "force_stop_recording") return UNHANDLED;
    // Force stop is a reset: it invalidates every admission and result, then
    // refuses while a browser recording still owns the microphone.
    this.recordingGeneration += 1;
    this.recordingAdmissions.clear();
    this.recordingResults.clear();
    this.notifyRecordingWaiters();
    if (this.recordingIsExternal)
      throw new Error("Browser recording has not ended");
    this.recordingOwner = null;
    this.recordingOwnerToken = null;
    this.notifyRecordingWaiters();
    return undefined;
  }

  /** Browser capture handoff plus the release commands that follow it. */
  private invokeBrowserRecording(command: string, args: WireRecord): unknown {
    if (command === "claim_browser_recording")
      return this.claimPreviewBrowserRecording(args);
    if (command === "release_browser_recording")
      return this.releasePreviewBrowserRecording(args);
    if (command === "discard_recording")
      return this.discardPreviewRecording(args);
    if (command !== "acknowledge_recording") return UNHANDLED;
    // Only the owner of an admission may drop its retained result.
    if (
      typeof args.generation === "number" &&
      this.recordingResults.get(args.generation)?.ownerId === args.ownerId
    )
      this.recordingResults.delete(args.generation);
    return undefined;
  }

  private invokeSystem(command: string, args: WireRecord): unknown {
    if (
      [
        "start_recording",
        "recording_generation",
        "claim_browser_recording",
        "release_browser_recording",
        "stop_recording",
        "acknowledge_recording",
        "discard_recording",
        "pause_recording",
        "resume_recording",
        "force_stop_recording",
      ].includes(command)
    ) {
      return this.invokeRecording(command, args);
    }
    if (SYSTEM_NO_OP_COMMANDS.has(command)) return undefined;
    // Permissions reflect the current scenario, unlike the static replies.
    if (command === "check_microphone_permission") {
      return clone(getAppState().permissions.microphone);
    }
    if (command === "check_accessibility_permission") {
      return clone(getAppState().permissions.accessibility);
    }
    if (SYSTEM_RESPONSES.has(command))
      return clone(SYSTEM_RESPONSES.get(command));
    throw new PreviewOperationError(command);
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
  args?: Record<string, unknown>,
): Promise<T> => runtime.invoke(command, args).then((value) => value as T);

export const previewScenarioFromLocation = (
  location: Location,
): PreviewScenarioId => {
  const explicitScenario = new URLSearchParams(location.search).get("scenario");
  return isPreviewScenarioId(explicitScenario)
    ? explicitScenario
    : scenarioForPath(location.pathname);
};

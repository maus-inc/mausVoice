import type {
  AgentMode,
  DictationPillVisibility,
  Nullable,
  PillPlacement,
  PillResetMonitorStrategy,
  PostProcessingMode,
  TranscriptionMode,
  UpdateChannel,
} from "./common.types";

export type UserPreferences = {
  userId: string;
  transcriptionMode: Nullable<TranscriptionMode>;
  transcriptionApiKeyId: Nullable<string>;
  transcriptionDevice: Nullable<string>;
  transcriptionModelSize: Nullable<string>;
  postProcessingMode: Nullable<PostProcessingMode>;
  postProcessingApiKeyId: Nullable<string>;
  postProcessingOllamaUrl: Nullable<string>;
  postProcessingOllamaModel: Nullable<string>;
  activeToneId: Nullable<string>;
  gotStartedAt: Nullable<number>;
  gpuEnumerationEnabled: boolean;
  agentMode: Nullable<AgentMode>;
  agentModeApiKeyId: Nullable<string>;
  openclawGatewayUrl: Nullable<string>;
  openclawToken: Nullable<string>;
  lastSeenFeature: Nullable<string>;
  activeDictationLanguage: Nullable<string>;
  preferredMicrophone: Nullable<string>;
  ignoreUpdateDialog: boolean;
  incognitoModeEnabled: boolean;
  incognitoModeIncludeInStats: boolean;
  preserveAudioOnFailure: boolean;
  dictationLimitMinutes: number;
  dictationPillVisibility: DictationPillVisibility;
  realtimeOutputEnabled: boolean;
  remoteOutputEnabled: boolean;
  remoteTargetDeviceId: Nullable<string>;
  remoteReceiverPort: Nullable<number>;
  remoteReceiverAutoStart: boolean;
  dictationAudioDim: number;
  pasteKeybind: Nullable<string>;
  menuBarIconHidden: boolean;
  insertionMethod: Nullable<string>;
  typingSpeedMs: Nullable<number>;
  pillResetMonitorStrategy: PillResetMonitorStrategy;
  pillPlacement: PillPlacement;
  /** Update channel; beta offers prereleases and may lag back to stable. */
  updateChannel: UpdateChannel;
  alwaysRequestAdminOnStartup: boolean;
  handsFreeDelayMs: Nullable<number>;
  /** Optional opt-in for activation-key + arrow style cycling while dictating. */
  inDictationStyleSwitchingEnabled: boolean;
  /** Suppress common silence hallucinations before post-processing. */
  hallucinationFilterEnabled: boolean;
  /**
   * Style short dictations with the deterministic local transforms instead of
   * sending them to the configured provider. Long dictations always use the
   * provider. Defaults to on; only meaningful while post-processing mode is
   * "api", because "none" already styles every dictation locally.
   */
  fastStyleShortDictationsEnabled: boolean;
  /** Review transcript text in the composer before inserting it. */
  reviewBeforeInsert: Nullable<boolean>;
  /** Tools enabled for agent mode; null means use the built-in registry defaults. */
  agentEnabledTools: Nullable<string[]>;
  /** Maximum agent loop iterations, clamped by the settings UI. */
  agentMaxIterations: number;
  /** Time allowed for a user permission response. */
  agentPermissionTimeoutMs: number;
  /** Deterministic "new line" / "scratch that" commands. Default on. */
  spokenCommandsEnabled: boolean;
  autoLearnDictionaryEnabled: boolean;
  autoLearnFromEditsEnabled: boolean;
  /** Opt-in to send the dictionary as ElevenLabs keyterms. Adds a 20% transcription surcharge, so it defaults to off and requires explicit acknowledgment. */
  elevenLabsKeytermsEnabled: boolean;
  /** JSON object of expansion feature-name -> boolean flag. */
  expansionFlags: string;
  /**
   * Hold the microphone open between dictations.
   *
   * Opening a capture device is the delay between a press and the first captured
   * sample, so a held device is what makes a press feel instant. The cost is the
   * operating system's microphone-in-use indicator, which stays lit for as long
   * as the device is held, so this is opt-in.
   */
  keepMicrophoneReady: boolean;
  /**
   * Seconds of audio from before the press to keep, so a word started early is
   * not clipped. Bounded to the range the recorder accepts.
   */
  microphonePrerollSeconds: number;

  // deprecated
};

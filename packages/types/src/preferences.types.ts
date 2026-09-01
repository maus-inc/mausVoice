import type {
  AgentMode,
  DictationPillVisibility,
  Nullable,
  PillPlacement,
  PillResetMonitorStrategy,
  PostProcessingMode,
  TranscriptionMode,
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
  alwaysRequestAdminOnStartup: boolean;
<<<<<<< HEAD
  handsFreeDelayMs: Nullable<number>;
=======
  /** Optional opt-in for activation-key + arrow style cycling while dictating. */
  inDictationStyleSwitchingEnabled: boolean;
  /** Suppress common silence hallucinations before post-processing. */
  hallucinationFilterEnabled: boolean;
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
>>>>>>> origin/fix/superfix-review-findings

  // deprecated
};

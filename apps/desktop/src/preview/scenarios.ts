import type {
  ApiKey,
  AppTarget,
  ChatMessage,
  Conversation,
  Hotkey,
  Term,
  Tone,
  Transcription,
  User,
  UserPreferences,
} from "@maus-inc/types";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import { createDefaultPreferences } from "../actions/user.actions";
import { LOCAL_USER_ID } from "../utils/user.utils";

export const PREVIEW_SCENARIOS = [
  "populated",
  "empty",
  "welcome",
  "onboarding",
  "permission-denied",
] as const;

export type PreviewScenarioId = (typeof PREVIEW_SCENARIOS)[number];

export type PreviewScenarioDefinition = {
  id: PreviewScenarioId;
  label: string;
  description: string;
};

export const PREVIEW_SCENARIO_DEFINITIONS: PreviewScenarioDefinition[] = [
  {
    id: "populated",
    label: "Populated workspace",
    description:
      "An onboarded person with representative history and settings.",
  },
  {
    id: "empty",
    label: "Empty workspace",
    description: "An onboarded person before they have created content.",
  },
  {
    id: "welcome",
    label: "First visit",
    description: "The unauthenticated welcome experience.",
  },
  {
    id: "onboarding",
    label: "Onboarding",
    description: "A signed-in person who has not finished setup.",
  },
  {
    id: "permission-denied",
    label: "Permission needed",
    description: "A dashboard workspace with the permissions dialog visible.",
  },
];

export type PreviewData = {
  user: User | null;
  preferences: UserPreferences | null;
  terms: Term[];
  apiKeys: ApiKey[];
  customTones: Tone[];
  hotkeys: Hotkey[];
  appTargets: AppTarget[];
  transcriptions: Transcription[];
  conversations: Conversation[];
  chatMessages: ChatMessage[];
};

export type PreviewScenarioSnapshot = {
  state: AppState;
  data: PreviewData;
};

const PREVIEW_AUTH = {
  uid: LOCAL_USER_ID,
  email: "preview@mausvoice.local",
  displayName: "Morgan Lee",
  providers: ["preview"],
};

const now = "2026-09-09T09:30:00.000Z";

const createPreviewUser = (onboarded: boolean): User => ({
  id: LOCAL_USER_ID,
  createdAt: "2026-07-02T08:00:00.000Z",
  updatedAt: now,
  name: "Morgan Lee",
  bio: "Product designer and frequent voice-dictation user.",
  company: "Northstar Studio",
  title: "Product Designer",
  onboarded,
  onboardedAt: onboarded ? "2026-07-02T08:15:00.000Z" : null,
  timezone: "Africa/Lagos",
  preferredMicrophone: "Preview microphone",
  preferredLanguage: "en",
  wordsThisMonth: 12_840,
  wordsThisMonthMonth: "2026-09",
  wordsTotal: 84_120,
  playInteractionChime: true,
  interactionFeedbackVolume: 0.35,
  hasFinishedTutorial: onboarded,
  hasMigratedPreferredMicrophone: true,
  cohort: "preview",
  stylingMode: "manual",
  selectedToneId: "email",
  activeToneIds: ["default", "email", "notes"],
  streak: 12,
  streakRecordedAt: "2026-09-09",
  referralSource: "Preview scenario",
});

const createPreviewPreferences = (): UserPreferences => ({
  ...createDefaultPreferences(),
  userId: LOCAL_USER_ID,
  transcriptionMode: "local",
  transcriptionDevice: "CPU",
  transcriptionModelSize: "small",
  postProcessingMode: "none",
  activeToneId: "default",
  gotStartedAt: null,
  preferredMicrophone: "Preview microphone",
  dictationPillVisibility: "while_active",
  pillPlacement: "bottom",
  spokenCommandsEnabled: true,
});

const previewTerms: Term[] = [
  {
    id: "term-mausvoice",
    createdAt: "2026-09-08T13:05:00.000Z",
    sourceValue: "mouse voice",
    destinationValue: "mausVoice",
    isReplacement: true,
  },
  {
    id: "term-northstar",
    createdAt: "2026-09-06T09:00:00.000Z",
    sourceValue: "Northstar",
    destinationValue: "",
    isReplacement: false,
  },
  {
    id: "term-ux",
    createdAt: "2026-09-02T11:20:00.000Z",
    sourceValue: "UX",
    destinationValue: "",
    isReplacement: false,
  },
];

const previewApiKeys: ApiKey[] = [
  {
    id: "preview-openai-key",
    name: "OpenAI workspace key",
    provider: "openai",
    createdAt: "2026-08-14T09:00:00.000Z",
    keySuffix: "…preview",
    // This is deliberately not a credential. The browser preview never makes
    // provider requests and the UI only needs metadata to demonstrate states.
    keyFull: null,
    transcriptionModel: "gpt-4o-mini-transcribe",
    postProcessingModel: "gpt-4o-mini",
  },
];

const previewCustomTones: Tone[] = [
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description: "Turn a spoken update into concise notes with next steps.",
    promptTemplate:
      "Turn this into concise meeting notes. Preserve decisions, owners, and next steps.",
    isSystem: false,
    createdAt: 1_725_780_000_000,
    sortOrder: 12,
    category: "notes",
    outputLength: "Short sections and bullets",
  },
];

const previewHotkeys: Hotkey[] = [
  { id: "dictate", actionName: "dictate", keys: ["Alt", "Space"] },
  { id: "agent", actionName: "agent", keys: ["Alt", "Enter"] },
  { id: "style-email", actionName: "style-email", keys: ["Alt", "E"] },
];

const previewAppTargets: AppTarget[] = [
  {
    id: "slack",
    name: "Slack",
    createdAt: "2026-08-20T09:00:00.000Z",
    toneId: "chat",
    iconPath: "preview://icons/slack",
    pasteKeybind: null,
    insertionMethod: null,
    typingSpeedMs: null,
  },
  {
    id: "notion",
    name: "Notion",
    createdAt: "2026-08-22T09:00:00.000Z",
    toneId: "notes",
    iconPath: "preview://icons/notion",
    pasteKeybind: "Ctrl+V",
    insertionMethod: "paste",
    typingSpeedMs: null,
  },
];

const previewTranscriptions: Transcription[] = [
  {
    id: "transcription-brief",
    createdAt: "2026-09-09T08:46:00.000Z",
    createdByUserId: LOCAL_USER_ID,
    transcript:
      "The new onboarding flow should make the microphone check feel optional until people are ready to try dictation.",
    isDeleted: false,
    audio: { filePath: "preview://audio/brief", durationMs: 12_500 },
    modelSize: "small",
    inferenceDevice: "CPU",
    rawTranscript:
      "the new onboarding flow should make the microphone check feel optional until people are ready to try dictation",
    sanitizedTranscript:
      "The new onboarding flow should make the microphone check feel optional until people are ready to try dictation.",
    transcriptionMode: "local",
    transcriptionDurationMs: 960,
  },
  {
    id: "transcription-status",
    createdAt: "2026-09-08T15:20:00.000Z",
    createdByUserId: LOCAL_USER_ID,
    transcript:
      "Design review: simplify the empty state, tighten the heading, and make the primary action more explicit.",
    isDeleted: false,
    audio: { filePath: "preview://audio/status", durationMs: 9_800 },
    modelSize: "small",
    inferenceDevice: "CPU",
    transcriptionMode: "local",
    transcriptionDurationMs: 720,
  },
  {
    id: "transcription-email",
    createdAt: "2026-09-06T11:10:00.000Z",
    createdByUserId: LOCAL_USER_ID,
    transcript:
      "Hi team, the prototype is ready for feedback. Please add comments before Thursday afternoon. Thanks, Morgan.",
    isDeleted: false,
    audio: { filePath: "preview://audio/email", durationMs: 14_100 },
    modelSize: "small",
    inferenceDevice: "CPU",
    transcriptionMode: "local",
    transcriptionDurationMs: 1_140,
  },
];

const previewConversations: Conversation[] = [
  {
    id: "conversation-design-review",
    title: "Plan a design review",
    createdAt: "2026-09-08T13:00:00.000Z",
    updatedAt: "2026-09-09T08:12:00.000Z",
  },
  {
    id: "conversation-release-notes",
    title: "Draft release notes",
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: "2026-09-06T10:22:00.000Z",
  },
];

const previewChatMessages: ChatMessage[] = [
  {
    id: "message-design-user",
    conversationId: "conversation-design-review",
    role: "user",
    content:
      "Create a short agenda for a design review of the new onboarding flow.",
    createdAt: "2026-09-09T08:10:00.000Z",
    metadata: null,
  },
  {
    id: "message-design-assistant",
    conversationId: "conversation-design-review",
    role: "assistant",
    content:
      "## Onboarding design review\n\n1. Revisit the first-run promise and primary action.\n2. Walk through microphone and accessibility permission states.\n3. Review empty, loading, and recovery states.\n4. Agree owners and the next prototype checkpoint.",
    createdAt: "2026-09-09T08:12:00.000Z",
    metadata: null,
  },
  {
    id: "message-release-user",
    conversationId: "conversation-release-notes",
    role: "user",
    content:
      "Draft concise release notes for an improved transcription history.",
    createdAt: "2026-09-06T10:20:00.000Z",
    metadata: null,
  },
];

const clone = <T>(value: T): T => structuredClone(value);

const setCollectionsOnState = (state: AppState, data: PreviewData): void => {
  if (data.user) {
    state.userById[data.user.id] = clone(data.user);
  }
  for (const term of data.terms) state.termById[term.id] = clone(term);
  for (const apiKey of data.apiKeys)
    state.apiKeyById[apiKey.id] = clone(apiKey);
  for (const tone of data.customTones) state.toneById[tone.id] = clone(tone);
  for (const hotkey of data.hotkeys)
    state.hotkeyById[hotkey.id] = clone(hotkey);
  for (const target of data.appTargets)
    state.appTargetById[target.id] = clone(target);
  for (const transcription of data.transcriptions) {
    state.transcriptionById[transcription.id] = clone(transcription);
  }
  for (const conversation of data.conversations) {
    state.conversationById[conversation.id] = clone(conversation);
  }
  for (const message of data.chatMessages) {
    state.chatMessageById[message.id] = clone(message);
    const ids =
      state.chatMessageIdsByConversationId[message.conversationId] ?? [];
    ids.push(message.id);
    state.chatMessageIdsByConversationId[message.conversationId] = ids;
  }

  state.dictionary.termIds = data.terms.map((term) => term.id);
  state.transcriptions.transcriptionIds = data.transcriptions.map(
    (transcription) => transcription.id,
  );
  state.chat.conversationIds = data.conversations.map(
    (conversation) => conversation.id,
  );
};

const workspaceSnapshot = (
  data: Omit<PreviewData, "user" | "preferences">,
  options: { permissionsDenied?: boolean } = {},
): PreviewScenarioSnapshot => {
  const user = createPreviewUser(true);
  const preferences = createPreviewPreferences();
  const state = clone(INITIAL_APP_STATE);
  state.initialized = true;
  state.auth = clone(PREVIEW_AUTH);
  state.userPrefs = clone(preferences);
  state.settings.elevationStartupPending = false;
  state.tones.selectedToneId = user.selectedToneId ?? null;
  state.settings.aiTranscription.mode = preferences.transcriptionMode;
  state.settings.aiTranscription.modelSize =
    preferences.transcriptionModelSize ??
    state.settings.aiTranscription.modelSize;
  state.settings.aiTranscription.device =
    preferences.transcriptionDevice ?? state.settings.aiTranscription.device;
  // AppSideEffects normally loads these desktop-wide collections. The preview
  // intentionally omits that native startup tree, so seed the settings slices
  // directly for routes that consume them before opening a dialog.
  state.settings.apiKeys = clone(data.apiKeys);
  state.settings.apiKeysStatus = "success";
  state.settings.hotkeyIds = data.hotkeys.map((hotkey) => hotkey.id);
  state.settings.hotkeysStatus = "success";
  state.permissions = options.permissionsDenied
    ? {
        microphone: {
          kind: "microphone",
          state: "denied",
          promptShown: true,
        },
        accessibility: {
          kind: "accessibility",
          state: "denied",
          promptShown: true,
        },
      }
    : {
        microphone: {
          kind: "microphone",
          state: "authorized",
          promptShown: true,
        },
        accessibility: {
          kind: "accessibility",
          state: "authorized",
          promptShown: true,
        },
      };

  const fullData: PreviewData = { user, preferences, ...data };
  setCollectionsOnState(state, fullData);
  return { state, data: fullData };
};

const populatedSnapshot = (): PreviewScenarioSnapshot =>
  workspaceSnapshot({
    terms: clone(previewTerms),
    apiKeys: clone(previewApiKeys),
    customTones: clone(previewCustomTones),
    hotkeys: clone(previewHotkeys),
    appTargets: clone(previewAppTargets),
    transcriptions: clone(previewTranscriptions),
    conversations: clone(previewConversations),
    chatMessages: clone(previewChatMessages),
  });

const emptySnapshot = (): PreviewScenarioSnapshot =>
  workspaceSnapshot({
    terms: [],
    apiKeys: [],
    customTones: [],
    hotkeys: clone(previewHotkeys),
    appTargets: [],
    transcriptions: [],
    conversations: [],
    chatMessages: [],
  });

const welcomeSnapshot = (): PreviewScenarioSnapshot => ({
  state: clone(INITIAL_APP_STATE),
  data: {
    user: null,
    preferences: null,
    terms: [],
    apiKeys: [],
    customTones: [],
    hotkeys: [],
    appTargets: [],
    transcriptions: [],
    conversations: [],
    chatMessages: [],
  },
});

const onboardingSnapshot = (): PreviewScenarioSnapshot => {
  const state = clone(INITIAL_APP_STATE);
  const user = createPreviewUser(false);
  const preferences = createPreviewPreferences();
  state.initialized = true;
  state.auth = clone(PREVIEW_AUTH);
  state.userById[user.id] = clone(user);
  state.userPrefs = clone(preferences);
  state.settings.elevationStartupPending = false;
  state.permissions = {
    microphone: {
      kind: "microphone",
      state: "not-determined",
      promptShown: false,
    },
    accessibility: {
      kind: "accessibility",
      state: "not-determined",
      promptShown: false,
    },
  };
  state.onboarding.currentPage = "signIn";
  return {
    state,
    data: {
      user,
      preferences,
      terms: [],
      apiKeys: [],
      customTones: [],
      hotkeys: clone(previewHotkeys),
      appTargets: [],
      transcriptions: [],
      conversations: [],
      chatMessages: [],
    },
  };
};

export const createPreviewScenario = (
  scenario: PreviewScenarioId,
): PreviewScenarioSnapshot => {
  switch (scenario) {
    case "empty":
      return emptySnapshot();
    case "welcome":
      return welcomeSnapshot();
    case "onboarding":
      return onboardingSnapshot();
    case "permission-denied":
      return workspaceSnapshot(
        {
          terms: clone(previewTerms),
          apiKeys: clone(previewApiKeys),
          customTones: clone(previewCustomTones),
          hotkeys: clone(previewHotkeys),
          appTargets: clone(previewAppTargets),
          transcriptions: clone(previewTranscriptions),
          conversations: clone(previewConversations),
          chatMessages: clone(previewChatMessages),
        },
        { permissionsDenied: true },
      );
    case "populated":
    default:
      return populatedSnapshot();
  }
};

export const isPreviewScenarioId = (
  value: string | null,
): value is PreviewScenarioId =>
  value !== null && PREVIEW_SCENARIOS.includes(value as PreviewScenarioId);

export const scenarioForPath = (pathname: string): PreviewScenarioId => {
  if (pathname === "/welcome" || pathname === "/login") return "welcome";
  if (pathname === "/onboarding") return "onboarding";
  return "populated";
};

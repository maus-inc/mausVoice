import {
  ApiKey,
  AppTarget,
  ChatMessage,
  Conversation,
  Hotkey,
  Member,
  PairedRemoteDevice,
  Term,
  Tone,
  ToolInfo,
  ToolPermission,
  Transcription,
  User,
} from "@maus-inc/types";
import type {
  AppState,
  SnackbarAction,
  SnackbarMode,
} from "../state/app.state";

/**
 * How many pending requests the queue keeps.
 *
 * Large enough that no realistic batch loses a message, small enough that the
 * array cannot grow for the life of the session.
 */
export const SNACKBAR_QUEUE_LIMIT = 20;

export type ShowSnackbarOpts = {
  duration?: number;
  transitionDuration?: number;
  mode?: SnackbarMode;
  action?: SnackbarAction;
};

export const setSnackbar = (
  draft: AppState,
  message: string,
  opts?: ShowSnackbarOpts,
): void => {
  const counter = draft.snackbarCounter + 1;
  const mode = opts?.mode ?? "info";
  const duration = opts?.duration ?? 3000;
  draft.snackbarRequests.push({
    counter,
    message,
    mode,
    duration,
    transitionDuration: opts?.transitionDuration,
    action: opts?.action,
  });
  // Bounded, because entries are only ever removed by this line: the emitter
  // reads the queue and never trims it. A long session raises hundreds of these
  // and each holds a closure while its action is queued. The limit is far above
  // the number of requests that can be pending at once -- the emitter drains the
  // whole queue in one pass -- so a trim only ever drops requests that were
  // already shown, never one that was waiting.
  const overflow = draft.snackbarRequests.length - SNACKBAR_QUEUE_LIMIT;
  if (overflow > 0) {
    draft.snackbarRequests.splice(0, overflow);
  }
  // The scalars stay as a mirror of the newest request. They used to be the
  // only copy, so a second message raised in the same tick overwrote the first
  // and the first was never shown; the queue above is the real store now.
  draft.snackbarMessage = message;
  draft.snackbarCounter = counter;
  draft.snackbarMode = mode;
  draft.snackbarDuration = duration;
  draft.snackbarTransitionDuration = opts?.transitionDuration;
  draft.snackbarAction = opts?.action;
};

export const registerUsers = (draft: AppState, users: User[]): void => {
  for (const user of users) {
    draft.userById[user.id] = user;
  }
};

export const registerTranscriptions = (
  draft: AppState,
  transcriptions: Transcription[],
): void => {
  for (const transcription of transcriptions) {
    draft.transcriptionById[transcription.id] = transcription;
  }
};

/**
 * Every written value in the user's dictionary: each source plus each
 * replacement destination. Glossary terms carry an empty destination, so
 * they contribute only their source. Consumers use this to dedupe against
 * existing dictionary values.
 */
export const collectTermValues = (state: AppState): string[] =>
  Object.values(state.termById).flatMap((term) =>
    term.destinationValue
      ? [term.sourceValue, term.destinationValue]
      : [term.sourceValue],
  );

export const registerTerms = (draft: AppState, terms: Term[]): void => {
  for (const term of terms) {
    draft.termById[term.id] = term;
  }
};

export const registerHotkeys = (draft: AppState, hotkeys: Hotkey[]): void => {
  for (const hotkey of hotkeys) {
    draft.hotkeyById[hotkey.id] = hotkey;
  }
};

export const registerApiKeys = (draft: AppState, apiKeys: ApiKey[]): void => {
  for (const apiKey of apiKeys) {
    draft.apiKeyById[apiKey.id] = apiKey;
  }
};

export const registerTones = (draft: AppState, tones: Tone[]): void => {
  for (const tone of tones) {
    draft.toneById[tone.id] = tone;
  }
};

export const registerMembers = (draft: AppState, members: Member[]): void => {
  for (const member of members) {
    draft.memberById[member.id] = member;
  }
};

export const registerAppTargets = (
  draft: AppState,
  appTargets: AppTarget[],
): void => {
  for (const appTarget of appTargets) {
    draft.appTargetById[appTarget.id] = appTarget;
  }
};

export const registerConversations = (
  draft: AppState,
  conversations: Conversation[],
): void => {
  for (const conversation of conversations) {
    draft.conversationById[conversation.id] = conversation;
  }
};

export const registerToolInfos = (
  draft: AppState,
  toolInfos: ToolInfo[],
): void => {
  for (const toolInfo of toolInfos) {
    draft.toolInfoById[toolInfo.id] = toolInfo;
  }
};

export const registerToolPermission = (
  draft: AppState,
  permission: ToolPermission,
): void => {
  draft.toolPermissionById[permission.id] = permission;
};

export const registerChatMessages = (
  draft: AppState,
  conversationId: string,
  messages: ChatMessage[],
): void => {
  for (const message of messages) {
    draft.chatMessageById[message.id] = message;
  }
  draft.chatMessageIdsByConversationId[conversationId] = messages
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => m.id);
};

export const registerPairedRemoteDevices = (
  draft: AppState,
  devices: PairedRemoteDevice[],
): void => {
  for (const device of devices) {
    draft.pairedRemoteDeviceById[device.id] = device;
  }
};

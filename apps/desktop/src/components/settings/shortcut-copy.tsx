import type { ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import {
  ADD_TO_DICTIONARY_HOTKEY,
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  OPEN_CHAT_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
} from "../../utils/keyboard.utils";

/**
 * What each shortcut is called, and what it does, in one place.
 *
 * Three surfaces show these keys — the shortcuts dialog, the quick-access card
 * on the overview, and the tooltip on that card — and a key named in one and
 * described in another used to mean three chances to disagree. The copy lives
 * here, keyed by the action the keyboard utilities already use, so a row can
 * only ever say what every other row says.
 *
 * The descriptions are the dialog's, because the dialog is where a shortcut is
 * explained in full: the tooltip on the card is that same explanation, one hover
 * away, rather than a shortened second version of it.
 */
export type ShortcutCopy = {
  action: string;
  title: ReactNode;
  description: ReactNode;
};

const dictate: ShortcutCopy = {
  action: DICTATE_HOTKEY,
  title: <FormattedMessage defaultMessage="Hold to dictate" />,
  description: (
    <FormattedMessage defaultMessage="Hold the key to record, release to transcribe your speech into text with AI." />
  ),
};

const assistantDictate: ShortcutCopy = {
  action: AGENT_DICTATE_HOTKEY,
  title: <FormattedMessage defaultMessage="Assistant mode" />,
  description: (
    <FormattedMessage defaultMessage="Dictate commands for the AI to follow instead of just cleaning up text." />
  ),
};

const cancel: ShortcutCopy = {
  action: CANCEL_TRANSCRIPTION_HOTKEY,
  title: <FormattedMessage defaultMessage="Cancel transcription" />,
  description: (
    <FormattedMessage defaultMessage="Cancel the current dictation or agent session." />
  ),
};

const openChat: ShortcutCopy = {
  action: OPEN_CHAT_HOTKEY,
  title: <FormattedMessage defaultMessage="Open chat" />,
  description: (
    <FormattedMessage defaultMessage="Open the current assistant conversation in the main window." />
  ),
};

const addToDictionary: ShortcutCopy = {
  action: ADD_TO_DICTIONARY_HOTKEY,
  title: <FormattedMessage defaultMessage="Add to dictionary" />,
  description: (
    <FormattedMessage defaultMessage="Add the currently selected text to your dictionary." />
  ),
};

const nextStyle: ShortcutCopy = {
  action: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  title: <FormattedMessage defaultMessage="Next writing style" />,
  description: (
    <FormattedMessage defaultMessage="Cycle forward through your active writing styles while dictating." />
  ),
};

const previousStyle: ShortcutCopy = {
  action: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  title: <FormattedMessage defaultMessage="Previous writing style" />,
  description: (
    <FormattedMessage defaultMessage="Cycle backward through your active writing styles while dictating." />
  ),
};

export const SHORTCUT_COPY = {
  dictate,
  assistantDictate,
  cancel,
  openChat,
  addToDictionary,
  nextStyle,
  previousStyle,
} as const;

/**
 * The keys the shortcuts dialog lists, in its order.
 *
 * The assistant's key sits second because it is what the dictation key becomes
 * once assistant mode is on; the rest follow the order a session runs in.
 */
export const DIALOG_SHORTCUTS: ShortcutCopy[] = [
  dictate,
  assistantDictate,
  cancel,
  openChat,
  addToDictionary,
];

/**
 * The keys the quick-access card shows, most reached-for first.
 *
 * Deliberately not the dialog's order. This card is a shortcut to the keys
 * someone uses without opening settings, and adding to the dictionary comes up
 * far more often than opening the chat window — the chat key is a convenience
 * for an assistant session, so it sits last and only appears when there is an
 * assistant to open. The assistant's dictation key is not here at all: the
 * models card beside this one already reports assistant mode, and a key for it
 * in both cards would put the same subject in two places.
 */
export const QUICK_SHORTCUTS: ShortcutCopy[] = [
  dictate,
  cancel,
  addToDictionary,
  openChat,
];

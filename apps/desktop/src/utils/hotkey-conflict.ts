import { defineMessage } from "react-intl";

export const HOTKEY_CONFLICT_MESSAGE = defineMessage({
  defaultMessage:
    "Shortcuts changed elsewhere. Reopen this dialog and try again.",
});

/** Read a failure message without assuming the thrown value is an Error. */
const failureMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "";
};

export function isHotkeyConflict(error: unknown): boolean {
  try {
    const message = failureMessage(error);
    return (
      message.includes("DICTATION_HOTKEYS_CHANGED") ||
      message.includes("STYLE_HOTKEYS_CHANGED")
    );
  } catch {
    return false;
  }
}

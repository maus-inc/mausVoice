import { defineMessage } from "react-intl";

export const HOTKEY_CONFLICT_MESSAGE = defineMessage({
  defaultMessage:
    "Shortcuts changed elsewhere. Reopen this dialog and try again.",
});

export function isHotkeyConflict(error: unknown): boolean {
  try {
    const message =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
    return (
      message.includes("DICTATION_HOTKEYS_CHANGED") ||
      message.includes("STYLE_HOTKEYS_CHANGED")
    );
  } catch {
    return false;
  }
}

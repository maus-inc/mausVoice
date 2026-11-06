import type { UserPreferences } from "@maus-inc/types";

export type LocalInsertionSettings =
  | { method: "type"; delayMs: number }
  | { method: "paste"; keybind: string | null };

/** Resolve app overrides, falling back to user preferences and safe defaults. */
export const resolveLocalInsertionSettings = (
  app:
    | Partial<
        Pick<
          UserPreferences,
          "insertionMethod" | "typingSpeedMs" | "pasteKeybind"
        >
      >
    | null
    | undefined,
  prefs: typeof app,
  usesGlobalPasteKeybind: boolean,
): LocalInsertionSettings => {
  const method = app?.insertionMethod ?? prefs?.insertionMethod ?? "paste";
  if (method === "type") {
    return {
      method: "type",
      delayMs: app?.typingSpeedMs ?? prefs?.typingSpeedMs ?? 5,
    };
  }
  return {
    method: "paste",
    keybind: usesGlobalPasteKeybind
      ? (prefs?.pasteKeybind ?? null)
      : (app?.pasteKeybind ?? prefs?.pasteKeybind ?? null),
  };
};

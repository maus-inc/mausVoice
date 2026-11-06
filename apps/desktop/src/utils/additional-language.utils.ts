import type { AppState } from "../state/app.state";

export const ADDITIONAL_LANGUAGE_HOTKEY_PREFIX = "additional-language:";

export const getAdditionalLanguageActionName = (language: string): string =>
  `${ADDITIONAL_LANGUAGE_HOTKEY_PREFIX}${language}`;

export const getAdditionalLanguageCode = (
  actionName: string,
): string | null => {
  if (!actionName.startsWith(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX)) {
    return null;
  }

  const raw = actionName.slice(ADDITIONAL_LANGUAGE_HOTKEY_PREFIX.length);
  return raw.length > 0 ? raw : null;
};

export const getAdditionalLanguageHotkeys = (
  state: AppState,
): { actionName: string; language: string }[] =>
  Object.values(state.hotkeyById).flatMap((hotkey) => {
    if (!hotkey) return [];
    const language = getAdditionalLanguageCode(hotkey.actionName);
    return language ? [{ actionName: hotkey.actionName, language }] : [];
  });

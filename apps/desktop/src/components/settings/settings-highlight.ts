import { createContext, useContext } from "react";

/**
 * The setting key the current navigation asked to land on, if any. The layout
 * sets it when a link carries `#setting-<key>`, and rows read it to outline
 * themselves for a moment so the person can see where they arrived.
 */
export const SettingsHighlightContext = createContext<string | null>(null);

export const useSettingHighlight = (key: string): boolean =>
  useContext(SettingsHighlightContext) === key;

import { createContext, useContext } from "react";

/**
 * The setting key the current navigation asked to land on, if any. The layout
 * sets it when a link carries `#setting-<key>`, and rows read it to outline
 * themselves for a moment so the person can see where they arrived.
 */
export const SettingsHighlightContext = createContext<string | null>(null);

export const useSettingHighlight = (key: string): boolean =>
  useContext(SettingsHighlightContext) === key;

/**
 * The layout's focus helper, so a page can reveal one of its own rows (scroll
 * it into view and light it up) without owning the anchor machinery. A page
 * cannot use `useSettingsAnchor` itself: the hook belongs to the layout, which
 * holds the query and the availability snapshot the retry reads. The default is
 * a no-op so a page rendered on its own — a unit test, the preview surface —
 * behaves as if nothing asked for focus.
 */
export const SettingsFocusContext = createContext<(key: string) => void>(
  () => {},
);

export const useSettingsFocus = (): ((key: string) => void) =>
  useContext(SettingsFocusContext);

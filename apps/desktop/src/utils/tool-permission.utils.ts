import {
  getLocalStorage,
  TOOL_ALWAYS_ALLOW_STORAGE_PREFIX as TOOL_ALWAYS_ALLOW_PREFIX,
} from "./local-storage.utils";

/**
 * Always-allow decisions are scoped rather than one global switch. Existing
 * keys remain valid as the global scope for backwards compatibility.
 */
export const getToolAlwaysAllow = (
  toolId: string,
  scope = "global",
): boolean => {
  const storage = getLocalStorage();
  if (!storage) return false;
  const scopedKey = `${TOOL_ALWAYS_ALLOW_PREFIX}${scope}:${toolId}`;
  return (
    storage.getItem(scopedKey) === "true" ||
    storage.getItem(`${TOOL_ALWAYS_ALLOW_PREFIX}global:${toolId}`) === "true" ||
    storage.getItem(`${TOOL_ALWAYS_ALLOW_PREFIX}${toolId}`) === "true"
  );
};

export const setToolAlwaysAllow = (
  toolId: string,
  allowed: boolean,
  scope = "global",
): void => {
  const storage = getLocalStorage();
  if (!storage) return;
  const key = `${TOOL_ALWAYS_ALLOW_PREFIX}${scope}:${toolId}`;
  if (allowed) {
    storage.setItem(key, "true");
  } else {
    storage.removeItem(key);
    // Legacy unscoped keys predate per-conversation grants. Always drop
    // them on revoke so a leftover `tool_always_allow:<id>` cannot keep
    // auto-executing after the new scoped path says no.
    storage.removeItem(`${TOOL_ALWAYS_ALLOW_PREFIX}${toolId}`);
  }
};

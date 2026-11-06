const MODIFIERS: ReadonlyArray<{
  prefixes: readonly string[];
  mac: string;
  other: string;
}> = [
  { prefixes: ["meta"], mac: "⌘", other: "⊞" },
  { prefixes: ["control"], mac: "⌃", other: "Ctrl" },
  { prefixes: ["shift"], mac: "⇧", other: "Shift" },
  { prefixes: ["alt", "option"], mac: "⌥", other: "Alt" },
];

const ARROW_KEYS: Readonly<Record<string, string>> = {
  LeftArrow: "←",
  RightArrow: "→",
  UpArrow: "↑",
  DownArrow: "↓",
};

/** Format a key without depending on a runtime-specific platform detector. */
export const formatHotkeyLabel = (
  key: string,
  isMac: () => boolean,
  includeSide = true,
): string => {
  const lower = key.toLowerCase();
  if (lower.startsWith("key")) return key.slice(3).toUpperCase();
  for (const { prefixes, mac, other } of MODIFIERS) {
    if (prefixes.some((prefix) => lower.startsWith(prefix))) {
      const base = isMac() ? mac : other;
      const side = includeSide ? /(Left|Right)$/i.exec(key)?.[1] : undefined;
      return side ? `${base} ${side.charAt(0).toUpperCase()}` : base;
    }
  }
  if (lower.startsWith("function")) return "Fn";
  return ARROW_KEYS[key] ?? key;
};

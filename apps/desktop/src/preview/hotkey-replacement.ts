type WireRecord = Record<string, unknown>;
const PREFIX = "additional-language:";

function isHotkeyRecord(value: unknown): value is WireRecord {
  if (!value || typeof value !== "object") return false;
  const hotkey = value as WireRecord;
  return (
    typeof hotkey.id === "string" &&
    typeof hotkey.actionName === "string" &&
    Array.isArray(hotkey.keys) &&
    hotkey.keys.every((key: unknown) => typeof key === "string")
  );
}

function verifySnapshot(
  current: Map<string, WireRecord>,
  expected: unknown,
  prefix: string,
  includeDictate: boolean,
  conflict: string,
): void {
  if (!Array.isArray(expected) || !expected.every(isHotkeyRecord)) {
    throw new TypeError("Invalid dictation hotkeys");
  }
  const matching = [...current.values()].filter(
    (hotkey) =>
      (includeDictate && hotkey.actionName === "dictate") ||
      (typeof hotkey.actionName === "string" &&
        hotkey.actionName.startsWith(prefix)),
  );
  const expectedById = new Map(expected.map((hotkey) => [hotkey.id, hotkey]));
  if (
    expectedById.size !== expected.length ||
    matching.length !== expected.length ||
    matching.some((hotkey) => {
      const old = expectedById.get(hotkey.id);
      return (
        !old ||
        old.actionName !== hotkey.actionName ||
        JSON.stringify(old.keys) !== JSON.stringify(hotkey.keys)
      );
    })
  )
    throw new Error(conflict);
}

function insertAdditional(
  next: Map<string, WireRecord>,
  entries: unknown[],
  isGroupRow: (actionName: string) => boolean,
): void {
  for (const value of entries) {
    const hotkey = structuredClone(value);
    if (
      !isHotkeyRecord(hotkey) ||
      typeof hotkey.actionName !== "string" ||
      !isGroupRow(hotkey.actionName) ||
      next.has(String(hotkey.id))
    ) {
      throw new Error("Invalid or conflicting additional hotkey");
    }
    next.set(String(hotkey.id), hotkey);
  }
}

const isLanguageRow = (actionName: string): boolean =>
  actionName.startsWith(PREFIX) && actionName.length > PREFIX.length;

/** The dictation group is every dictate row plus every additional language. */
const isDictationRow = (actionName: string): boolean =>
  actionName === "dictate" || isLanguageRow(actionName);

/** Validate and stage the replacement without mutating the live preview database. */
export function replaceDictationHotkeys(
  current: Map<string, WireRecord>,
  args: WireRecord,
): Map<string, WireRecord> {
  const primary = structuredClone(args.primary);
  if (
    !isHotkeyRecord(primary) ||
    primary.actionName !== "dictate" ||
    !Array.isArray(args.additional)
  ) {
    throw new TypeError("Invalid dictation hotkeys");
  }
  verifySnapshot(
    current,
    args.expected,
    PREFIX,
    true,
    "DICTATION_HOTKEYS_CHANGED",
  );
  const next = new Map(current);
  for (const [id, hotkey] of next) {
    if (isDictationRow(String(hotkey.actionName))) next.delete(id);
  }
  if (next.has(String(primary.id)))
    throw new Error("Primary hotkey ID belongs to another action");
  next.set(String(primary.id), primary);
  insertAdditional(next, args.additional, isDictationRow);
  return next;
}

/** Stage a prefix replacement with the same collision and snapshot rules as SQLite. */
export function replaceStyleHotkeys(
  current: Map<string, WireRecord>,
  args: WireRecord,
): { next: Map<string, WireRecord>; hotkeys: WireRecord[] } {
  if (
    typeof args.prefix !== "string" ||
    !args.prefix ||
    !Array.isArray(args.hotkeys)
  ) {
    throw new TypeError("Expected a hotkey prefix and replacement list");
  }
  const prefix = args.prefix;
  verifySnapshot(
    current,
    args.expected,
    prefix,
    false,
    "STYLE_HOTKEYS_CHANGED",
  );
  const next = new Map(current);
  for (const [id, hotkey] of next) {
    if (String(hotkey.actionName).startsWith(prefix)) next.delete(id);
  }
  insertAdditional(
    next,
    args.hotkeys,
    (actionName) =>
      actionName.startsWith(prefix) && actionName.length > prefix.length,
  );
  return {
    next,
    hotkeys: args.hotkeys.map((hotkey: unknown) =>
      structuredClone(hotkey),
    ) as WireRecord[],
  };
}

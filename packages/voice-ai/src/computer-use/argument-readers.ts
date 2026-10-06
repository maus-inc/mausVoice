/**
 * Reading a model's own arguments without trusting them.
 *
 * A model asked to click at a coordinate emits JSON it composed itself, and
 * nothing guarantees the field it promised is a number rather than a string, or
 * present rather than absent. Two things follow, and they pull in opposite
 * directions.
 *
 * The first is that a missing or ill-typed field must never become a default.
 * Defaulting a coordinate to zero sends a real click to the top-left corner of
 * the user's screen, so an action that cannot be read has to arrive at the loop
 * as something the loop will refuse rather than as a plausible guess.
 *
 * The second is that the two providers spell the same idea differently, and
 * both spellings are legitimate: one writes a coordinate as two named numbers
 * and the other as a two-element array. These readers accept either, so the
 * adapters stay the only place the distinction exists.
 */

export type ComputerUseArguments = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The arguments object, or an empty one when the provider sent something else. */
export const readArguments = (value: unknown): ComputerUseArguments =>
  isRecord(value) ? value : {};

export const readNumber = (
  args: ComputerUseArguments,
  key: string,
): number | undefined => {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const readString = (
  args: ComputerUseArguments,
  key: string,
): string | undefined => {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

export const readBoolean = (
  args: ComputerUseArguments,
  key: string,
): boolean | undefined => {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
};

/**
 * A count bounded by a provider's own documented range.
 *
 * The bound is not decoration. An unbounded repeat turns one model turn into an
 * unbounded number of key presses against the user's machine, so a value the
 * provider never promised is rejected rather than clamped into something the
 * model did not ask for.
 */
export const readBoundedCount = (
  args: ComputerUseArguments,
  key: string,
  min: number,
  max: number,
): number | undefined => {
  const value = readNumber(args, key);
  if (value === undefined || !Number.isInteger(value)) {
    return undefined;
  }
  return value >= min && value <= max ? value : undefined;
};

/**
 * A number inside a provider's own documented range, told apart from an absent
 * one.
 *
 * `readBoundedCount` collapses those two into `undefined`, which is right when
 * a field has no documented default: a missing one and a wrong one both mean
 * the value cannot be used. It is wrong where the provider documents a default,
 * because a caller that then applies that default to an out-of-range value has
 * answered a request nobody made. Here an absent field is `undefined`, a value
 * that is present and unreadable or outside the range is `null`, and only the
 * first is a candidate for a documented default.
 */
export const readOptionalBoundedNumber = (
  args: ComputerUseArguments,
  key: string,
  min: number,
  max: number,
): number | null | undefined => {
  if (args[key] === undefined) {
    return undefined;
  }
  const value = readNumber(args, key);
  if (value === undefined || !Number.isFinite(value) || value < min || value > max) {
    return null;
  }
  return value;
};

/**
 * A duration in seconds, as milliseconds.
 *
 * A provider documents a ceiling in seconds because a request for more is a
 * mistake rather than an intent. Both ceilings are applied, so an action can
 * never hold the user's session open longer than the provider promised it could.
 */
export const readSecondsAsMs = (
  args: ComputerUseArguments,
  key: string,
  maxSeconds: number,
): number | undefined => {
  const value = readNumber(args, key);
  if (value === undefined || value < 0) {
    return undefined;
  }
  return Math.min(value, maxSeconds) * 1000;
};

export const readStringArray = (
  args: ComputerUseArguments,
  key: string,
): string[] | undefined => {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length && items.length > 0 ? items : undefined;
};

export const readNumberArray = (
  args: ComputerUseArguments,
  key: string,
): number[] | undefined => {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
  return items.length === value.length ? items : undefined;
};

/** `[x, y]`, the array spelling of a coordinate. */
export const readCoordinateArray = (
  args: ComputerUseArguments,
  key: string,
): { x: number; y: number } | undefined => {
  const pair = readNumberArray(args, key);
  return pair && pair.length === 2 ? { x: pair[0], y: pair[1] } : undefined;
};

/**
 * A point, in whichever of the two spellings the provider used.
 *
 * `named` covers the providers that write `x` and `y` as siblings; `tuple`
 * covers the ones that write them as a pair. A caller that needs both passes
 * both and reads whichever came back, so it never has to know the dialect.
 */
export const readPoint = (
  args: ComputerUseArguments,
  spellings: PointSpellings,
): { x: number; y: number } | undefined => {
  for (const key of spellings.tupleKeys) {
    const asPair = readCoordinateArray(args, key);
    if (asPair) {
      return asPair;
    }
  }
  const x = readNumber(args, spellings.xKey);
  const y = readNumber(args, spellings.yKey);
  return x === undefined || y === undefined ? undefined : { x, y };
};

/**
 * Where a provider puts a point.
 *
 * Every spelling a provider uses is declared here rather than probed for, so a
 * call site says exactly which argument keys it expects and a reader never
 * guesses. The tests are what catch a renamed key: these fields are plain
 * strings, so a typo compiles and the point is simply read as absent.
 */
export type PointSpellings = {
  xKey: string;
  yKey: string;
  /** Keys holding an `[x, y]` pair, tried before the named fields. */
  tupleKeys: readonly string[];
};
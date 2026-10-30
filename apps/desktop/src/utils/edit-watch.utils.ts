import {
  collectLearnableTerms,
  computeAddedTokens,
  computeRemovedTokens,
  tokenizeForComparison,
} from "./auto-learn.utils";

const MAX_EDIT_TOKENS = 8;

/**
 * Upper bound on the token count of either side of the comparison. The
 * alignment below is quadratic, so a field longer than this is not aligned at
 * all rather than spending a poll's worth of CPU on it. It sits far above any
 * realistic dictation target: 600 tokens is roughly 450 words.
 */
const MAX_ALIGNED_TOKENS = 600;

const SMART_APOSTROPHE_PATTERN = /[\u2018\u2019]/gu;

/**
 * The comparison key for a token. Case is folded so a corrected capital is
 * recognised as the same word, and smart typography is folded so a target app
 * that turns a straight quote curly does not read as a different word.
 */
const alignmentKey = (token: string): string =>
  token.replace(SMART_APOSTROPHE_PATTERN, "'").toLowerCase();

const alignmentKeys = (tokens: string[]): string[] => tokens.map(alignmentKey);

/**
 * Key for deciding whether an aligned token was actually *changed*.
 *
 * Unlike `alignmentKey` this keeps the case, because a case-only difference is
 * the whole point for a proper noun: dictating "mausvoice" and seeing "MausVoice"
 * in the field is a correction the user is teaching. It folds only smart
 * typography, which no user means to correct -- a target app that curly-quotes
 * the dictation has not been edited. Comparing raw reported those as gaps, and
 * because `consumeOriginalToken` keys on the lowercased raw token, a curly
 * quote counted as both added and removed; past eight of them the occurrence
 * caps rejected the entire correction.
 */
const changedTokenKey = (token: string): string =>
  token.replace(SMART_APOSTROPHE_PATTERN, "'");

/** True when the dictated run starts at `offset`. Keys are precomputed. */
const runMatchesAt = (
  keys: string[],
  offset: number,
  dictatedKeys: string[],
): boolean =>
  offset + dictatedKeys.length <= keys.length &&
  dictatedKeys.every((key, index) => keys[offset + index] === key);

/**
 * Counts how many times the dictated text occurs in a field.
 *
 * This is the containment gate for a baseline: the watcher only ever diffs a
 * field that actually received the dictation, so without it the next small edit
 * in whatever field happens to be focused later in the 90 second window would
 * read as a correction. It also rejects a snapshot taken before the paste
 * landed or after the user already corrected the dictation, because neither
 * describes the moment the dictation arrived.
 *
 * A paste adds an occurrence, so this is also the only signal available for
 * telling a read taken before the dictation landed from a read taken after it,
 * and it is what lets a duplicate dictation correct the second copy rather than
 * the first.
 *
 * The match is a run of whole tokens rather than a substring of the raw text.
 * A character search reports `recall ralphxyz` and `Ralphson` as holding
 * `call Ralph` and `Ralph`, and a false positive here is not harmless: the
 * snapshot becomes the baseline and the next small edit anywhere in that
 * unrelated field turns into a proposed term. Tokens still ignore case, smart
 * apostrophes and whitespace reflow, which is the only drift a target app
 * introduces.
 *
 * There is deliberately no length cap here. This is a scan for a fixed token
 * run, so it stays linear, and a cap would silently switch the whole feature
 * off in any field longer than the cutoff, with no log and nothing on screen
 * saying why. Only the quadratic alignment carries a bound, and it reports when
 * it gives up.
 */
export const countDictationOccurrences = (
  insertedText: string,
  fieldText: string,
): number => {
  const dictatedKeys = alignmentKeys(tokenizeForComparison(insertedText));
  const fieldKeys = alignmentKeys(tokenizeForComparison(fieldText));
  if (dictatedKeys.length === 0) {
    return 0;
  }
  let count = 0;
  for (
    let offset = 0;
    offset <= fieldKeys.length - dictatedKeys.length;
    offset += 1
  ) {
    if (runMatchesAt(fieldKeys, offset, dictatedKeys)) {
      count += 1;
    }
  }
  return count;
};

/**
 * Aligns the baseline against the current field and returns, for every
 * baseline token that survived into the field, the field token it matched.
 *
 * Matching folds case, so a corrected capital is an aligned pair rather than a
 * deletion plus an insertion. The table is a longest common subsequence, which
 * is what makes it safe to read every unmatched token as genuinely new or
 * genuinely gone: the longest possible set of shared tokens is anchored, and
 * the gaps between anchors are the only regions the user can have changed.
 */
const alignTokens = (
  baseline: string[],
  field: string[],
): Map<number, number> => {
  const columns = field.length + 1;
  // The table only ever holds a length and both sides are bounded by
  // MAX_ALIGNED_TOKENS, so 16 bits is always enough.
  const lengths = new Uint16Array((baseline.length + 1) * columns);
  const baselineKeys = alignmentKeys(baseline);
  const fieldKeys = alignmentKeys(field);

  // Every `lengths` read below is `row * columns + column` with `row` in
  // `0..baseline.length` and `column` in `0..field.length`, which the loop
  // bounds keep inside the allocation above. Funnelling them through one
  // accessor keeps that invariant in one place; the `?? 0` is only reachable if
  // a future edit breaks it, and a zero there is this table's own base value
  // rather than the `NaN` an out-of-range read would otherwise poison the row
  // with.
  const cell = (row: number, column: number): number =>
    lengths[row * columns + column] ?? 0;

  for (let row = 1; row <= baseline.length; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const shared =
        baselineKeys[row - 1] === fieldKeys[column - 1]
          ? cell(row - 1, column - 1) + 1
          : 0;
      lengths[row * columns + column] = Math.max(
        shared,
        cell(row - 1, column),
        cell(row, column - 1),
      );
    }
  }

  const anchors = new Map<number, number>();
  let row = baseline.length;
  let column = field.length;
  while (row > 0 && column > 0) {
    if (baselineKeys[row - 1] === fieldKeys[column - 1]) {
      anchors.set(row - 1, column - 1);
      row -= 1;
      column -= 1;
    } else if (cell(row - 1, column) >= cell(row, column - 1)) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return anchors;
};

type TokenGap = { baseline: string[]; field: string[] };

/**
 * The anchor closest to a boundary of the occurrence: the last one before it,
 * or the first one at or after it. Selection is by distance on the baseline
 * side because the map is filled in walk-back order, which runs backwards.
 */
const pickNearestAnchor = (
  anchors: Map<number, number>,
  boundary: number,
  side: "lower" | "upper",
): [number, number] | undefined => {
  const candidates = [...anchors]
    .filter(([baselineIndex]) =>
      side === "lower" ? baselineIndex < boundary : baselineIndex >= boundary,
    )
    .sort((left, right) => left[0] - right[0]);
  return side === "lower" ? candidates.at(-1) : candidates[0];
};

/**
 * Splits one dictation occurrence into the runs between its surviving tokens,
 * paired with the baseline runs those tokens replaced.
 *
 * Every gap is bounded on both sides by an aligned token or by a genuine edge
 * of the field, so a gap can never reach text the user edited outside the
 * dictation. That is what makes an edit to a heading above the dictation, or a
 * deletion next to it, unable to decide whether a real correction is learned.
 *
 * An aligned pair whose casing changed is emitted as a one-token gap as well.
 * The diff helpers already treat a token that matches case-insensitively but
 * not exactly as both added and removed, which is the same shape as a
 * substitution and is how a capital the recognizer dropped is learned.
 */
const collectRegionGaps = (args: {
  baseline: string[];
  field: string[];
  anchors: Map<number, number>;
  start: number;
  end: number;
}): TokenGap[] | null => {
  const { baseline, field, anchors, start, end } = args;
  const inSpan = [...anchors]
    .filter(([baselineIndex]) => baselineIndex >= start && baselineIndex < end)
    .sort((left, right) => left[0] - right[0]);

  // Without an anchor below or above the occurrence the region has no known
  // edge on that side, and the text there is not the dictation. Learn nothing
  // rather than attribute the user's rewrite of the surrounding field to it.
  // The nearest anchor has to be picked by distance on the baseline side:
  // `anchors` is filled in walk-back order, which runs from the end backwards.
  const lower = pickNearestAnchor(anchors, start, "lower");
  const upper = pickNearestAnchor(anchors, end, "upper");
  const openBelow = lower === undefined && start > 0;
  const openAbove = upper === undefined && end < baseline.length;
  if (openBelow || openAbove) {
    return null;
  }

  const fieldStart = lower ? lower[1] + 1 : 0;
  const fieldEnd = upper ? upper[1] : field.length;
  const boundaries: [number, number][] = [...inSpan, [end, fieldEnd]];

  // The anchor below the occurrence only says where the field was when the
  // dictation landed, not where the dictation itself starts. Anything the user
  // typed between that anchor and the dictation sits in between, so the leading
  // run has to begin at the first surviving dictated token instead. Without
  // this, a replacement of the first dictated word beside text the user typed
  // pairs that word against the typed text, and the prompt then offers the
  // typed text as the correction.
  //
  // This is about replacements. Text typed *inside* the dictation without
  // replacing anything is a different gap, with an empty baseline run, and
  // `collectRegionTerms` is what keeps it from being learned.
  const firstInSpan = inSpan[0];
  const regionStart = firstInSpan
    ? Math.max(fieldStart, firstInSpan[1] - (firstInSpan[0] - start))
    : fieldStart;

  const gaps: TokenGap[] = [];
  let baselineCursor = start;
  let fieldCursor = regionStart;
  for (const [baselineEdge, fieldEdge] of boundaries) {
    const baselineRun = baseline.slice(baselineCursor, baselineEdge);
    const fieldRun = field.slice(fieldCursor, fieldEdge);
    if (baselineRun.length > 0 || fieldRun.length > 0) {
      gaps.push({ baseline: baselineRun, field: fieldRun });
    }
    baselineCursor = baselineEdge + 1;
    fieldCursor = fieldEdge + 1;
  }

  for (const [baselineIndex, fieldIndex] of inSpan) {
    // `anchors` is only ever filled with `row - 1` / `column - 1`, where `row`
    // and `column` walk down from `baseline.length` / `field.length` and stop at
    // 1, so both indices are in range by construction. Reading them through a
    // guard keeps that fact checked instead of asserted.
    const baselineToken = baseline[baselineIndex];
    const fieldToken = field[fieldIndex];
    if (
      baselineToken === undefined ||
      fieldToken === undefined ||
      changedTokenKey(baselineToken) === changedTokenKey(fieldToken)
    ) {
      continue;
    }
    gaps.push({
      baseline: [baselineToken],
      field: [fieldToken],
    });
  }
  return gaps;
};

const collectRegionTerms = (
  gaps: TokenGap[],
  dictatedLength: number,
  existingTerms: string[],
): string[] => {
  // Added and removed are counted per gap, not across the region. A gap is a
  // replacement bounded by aligned tokens, so it is the only place where an
  // addition and a removal can be the same edit. Summing the two sides over the
  // whole region let an insertion anywhere in it ride along on a correction
  // somewhere else: type "Zeta" between "beta" and "call" and correct "Ralph" to
  // "Ralf", and "Zeta" was learned as if the recognizer had produced it. The
  // comment on `regionStart` describes that harm; this is what prevents it.
  const added: string[] = [];
  // Only ever read as a count, so it is tracked as one rather than built.
  let removedCount = 0;
  for (const gap of gaps) {
    const gapAdded = computeAddedTokens(
      gap.baseline.join(" "),
      gap.field.join(" "),
    );
    if (gapAdded.length === 0) {
      continue;
    }
    const gapRemoved = computeRemovedTokens(
      gap.baseline.join(" "),
      gap.field.join(" "),
    );
    if (gapRemoved.length === 0) {
      continue;
    }
    added.push(...gapAdded);
    removedCount += gapRemoved.length;
  }

  // A long list of added tokens means the user rewrote the text.
  if (added.length === 0 || added.length > MAX_EDIT_TOKENS) {
    return [];
  }

  // A pure insertion is the user adding their own words, not correcting the
  // dictation, and a long removal is a rewrite.
  if (removedCount === 0 || removedCount > MAX_EDIT_TOKENS) {
    return [];
  }

  const replacedEverything =
    dictatedLength > 1 && removedCount >= dictatedLength;
  if (replacedEverything) {
    return [];
  }

  return collectLearnableTerms(added, existingTerms);
};
/**
 * Returns the proper-noun terms the user corrected inside the dictated text.
 *
 * The diff runs against the region the dictation occupies rather than against
 * the whole field. The baseline is used only to align the two: document text
 * that was on screen before the dictation anchors to itself and never enters a
 * gap, so it is outside the comparison by construction rather than by
 * cancelling out.
 *
 * A correction is a small replacement: at least one token changed on each side
 * and both counts stay small. Replacing at least as much as was dictated means
 * the user rewrote the dictation instead of correcting it. A one-token
 * dictation has no partial state, so that guard does not apply to it:
 * "theory" to "Three" removes the only dictated token and is exactly the case
 * worth learning.
 *
 * Every occurrence of the dictation in the baseline is tried, so a second
 * dictation of the same text into the same field is learned from the copy the
 * user actually corrected.
 */
export const findEditCorrections = (args: {
  insertedText: string;
  baselineText: string;
  fieldText: string;
  existingTerms: string[];
  /** Called instead of returning silently when the field is too long to align. */
  onUnalignable?: (tokenCount: number) => void;
}): string[] => {
  const { insertedText, baselineText, fieldText, existingTerms } = args;
  const dictated = tokenizeForComparison(insertedText);
  const baseline = tokenizeForComparison(baselineText);
  const field = tokenizeForComparison(fieldText);
  if (dictated.length === 0) {
    return [];
  }
  const longestSide = Math.max(baseline.length, field.length);
  if (longestSide > MAX_ALIGNED_TOKENS) {
    // Nothing the user can see will explain the silence, so say so where a
    // developer can find it.
    args.onUnalignable?.(longestSide);
    return [];
  }

  const anchors = alignTokens(baseline, field);
  const dictatedKeys = alignmentKeys(dictated);
  const baselineKeys = alignmentKeys(baseline);
  const lastStart = baseline.length - dictated.length;

  for (let start = 0; start <= lastStart; start += 1) {
    if (!runMatchesAt(baselineKeys, start, dictatedKeys)) {
      continue;
    }
    const gaps = collectRegionGaps({
      baseline,
      field,
      anchors,
      start,
      end: start + dictated.length,
    });
    if (gaps) {
      const learned = collectRegionTerms(gaps, dictated.length, existingTerms);
      if (learned.length > 0) {
        return learned;
      }
    }
  }
  return [];
};

/**
 * The one place a post-processing failure is described.
 *
 * `classifyPostProcessErrorCategory` reduces a provider message to one of the
 * fixed strings below, and that string is what gets persisted on the
 * transcription row and pushed into the pipeline warnings. The localized
 * descriptors live beside it for the same reason: the failure toast renders
 * this text, so a category without a descriptor would print an internal English
 * string into a locale that does not speak English, and a descriptor without a
 * category would be dead catalog weight.
 *
 * The provider's own message is deliberately not here. Only the Groq and
 * Cerebras paths scrub credential material, and the Groq chain text names a
 * model id the provider picked, so rendering it would open a leak and an
 * injection surface that the log does not have. The full detail stays in the
 * log; the user reads the category.
 */
import { defineMessage } from "react-intl";

/** Localized wording for one classified category. */
export type PostProcessErrorReason = {
  defaultMessage: string;
};

/**
 * The seven categories, in the order the classifier tests them. Named so the
 * classifier, the descriptor table, and the drift test all reference the same
 * identifiers instead of repeating raw strings.
 */
export const POST_PROCESS_ERROR_CATEGORY = {
  quotaOrPayment: "Quota or payment required (402)",
  rateLimit: "Rate limit exceeded (429)",
  authentication: "Authentication failed",
  timedOut: "Post-processing timed out",
  aborted: "Request aborted",
  network: "Network error",
  provider: "Post-processing provider error",
} as const;

/**
 * Declared with `defineMessage` rather than a bare object so the extractor
 * finds each `defaultMessage` literal. A descriptor held in a plain record is
 * invisible to the extractor, which leaves the string in English in all nine
 * translated catalogs.
 */
const QUOTA_OR_PAYMENT = defineMessage({
  defaultMessage: "Quota or payment required",
});
const RATE_LIMIT_EXCEEDED = defineMessage({
  defaultMessage: "Rate limit exceeded",
});
const AUTHENTICATION_FAILED = defineMessage({
  defaultMessage: "Authentication failed",
});
const POST_PROCESSING_TIMED_OUT = defineMessage({
  defaultMessage: "Post-processing timed out",
});
const REQUEST_ABORTED = defineMessage({
  defaultMessage: "Request aborted",
});
const NETWORK_ERROR = defineMessage({
  defaultMessage: "Network error",
});
const PROVIDER_ERROR = defineMessage({
  defaultMessage: "Provider error",
});

/**
 * The exact string each classifier branch returns, paired with the message the
 * user sees for it. Keys must stay character-identical to the returns in
 * `classifyPostProcessErrorCategory`; a test asserts that for every branch.
 */
export const POST_PROCESS_ERROR_REASONS: Readonly<
  Record<string, PostProcessErrorReason>
> = {
  [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment]: QUOTA_OR_PAYMENT,
  [POST_PROCESS_ERROR_CATEGORY.rateLimit]: RATE_LIMIT_EXCEEDED,
  [POST_PROCESS_ERROR_CATEGORY.authentication]: AUTHENTICATION_FAILED,
  [POST_PROCESS_ERROR_CATEGORY.timedOut]: POST_PROCESSING_TIMED_OUT,
  [POST_PROCESS_ERROR_CATEGORY.aborted]: REQUEST_ABORTED,
  [POST_PROCESS_ERROR_CATEGORY.network]: NETWORK_ERROR,
  [POST_PROCESS_ERROR_CATEGORY.provider]: PROVIDER_ERROR,
};

/**
 * Used when a failure carries no category at all, so the toast stays whole.
 *
 * This must be the same `defineMessage` descriptor as the provider category,
 * not an object literal written here. The formatjs babel plugin only injects
 * the `id` it later builds the catalog from into a descriptor it can see at
 * that call, so a bare literal reaches `formatMessage` with no `id` and
 * `invariant(!!msgId)` throws there, in production too, before the toast that
 * was meant to explain the styling failure is ever shown. Reusing the
 * descriptor keeps `provider_error`, already translated in every catalog, as
 * the single fallback.
 */
export const UNKNOWN_POST_PROCESS_ERROR_REASON: PostProcessErrorReason =
  PROVIDER_ERROR;

/**
 * The message to render for a stored category. An unrecognized value is
 * possible because the field is read back from the database, which may hold a
 * category written by an older build, and the remote server's own metadata is
 * stored on the same row.
 *
 * `Object.hasOwn` is load bearing, not defensive noise. `POST_PROCESS_ERROR_REASONS` is an object
 * literal, so a plain `POST_PROCESS_ERROR_REASONS[category]` on the string
 * `"constructor"` returns the inherited `Object` constructor rather than
 * undefined. That value is truthy, so the `||` never falls through to the
 * fallback, and the function returns a function where its declared return type
 * is a message descriptor. The caller passes it straight to `formatMessage`,
 * which throws on a missing `id` before the toast is ever shown.
 */
export const postProcessErrorReason = (
  category: string | null | undefined,
): PostProcessErrorReason =>
  (category && Object.hasOwn(POST_PROCESS_ERROR_REASONS, category)
    ? POST_PROCESS_ERROR_REASONS[category]
    : undefined) || UNKNOWN_POST_PROCESS_ERROR_REASON;

/**
 * Reduce any provider message to one of the fixed categories above.
 *
 * The order matters: a 401 body also contains the word "quota" in some
 * providers, and a timeout also contains "abort", so the specific statuses are
 * checked before the generic ones.
 */
export const classifyPostProcessErrorCategory = (message: string): string => {
  const lower = message.toLowerCase();
  if (
    lower.includes("402") ||
    lower.includes("payment required") ||
    lower.includes("quota")
  ) {
    return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return POST_PROCESS_ERROR_CATEGORY.rateLimit;
  }
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("authentication")
  ) {
    return POST_PROCESS_ERROR_CATEGORY.authentication;
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return POST_PROCESS_ERROR_CATEGORY.timedOut;
  }
  if (lower.includes("abort") || lower.includes("cancelled")) {
    return POST_PROCESS_ERROR_CATEGORY.aborted;
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    lower.includes("fetch failed")
  ) {
    return POST_PROCESS_ERROR_CATEGORY.network;
  }
  return POST_PROCESS_ERROR_CATEGORY.provider;
};

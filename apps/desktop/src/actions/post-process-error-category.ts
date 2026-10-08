/**
 * The one place a post-processing provider failure is classified and described.
 * Provider detail stays in the log. User-facing copy uses only this closed set
 * of localized categories so it cannot expose credentials or model names.
 */
import { readProviderCode, readProviderStatus } from "@maus-inc/voice-ai";
import { defineMessage } from "react-intl";

/** Localized wording for one classified category. */
export type PostProcessErrorReason = {
  defaultMessage: string;
};

/** Stored category values are kept stable because transcription rows persist them. */
export const POST_PROCESS_ERROR_CATEGORY = {
  quotaOrPayment: "Quota or payment required (402)",
  rateLimit: "Rate limit exceeded (429)",
  providerLimit: "Provider request or usage limit reached",
  authentication: "Authentication failed",
  timedOut: "Post-processing timed out",
  aborted: "Request aborted",
  network: "Network error",
  provider: "Post-processing provider error",
} as const;

export type PostProcessErrorCategory =
  (typeof POST_PROCESS_ERROR_CATEGORY)[keyof typeof POST_PROCESS_ERROR_CATEGORY];

const QUOTA_OR_PAYMENT = defineMessage({
  defaultMessage: "the provider reported a quota or billing issue",
});
const RATE_LIMIT_EXCEEDED = defineMessage({
  defaultMessage: "the provider rate limit was reached",
});
const PROVIDER_LIMIT_REACHED = defineMessage({
  defaultMessage: "the provider request or usage limit was reached",
});
const AUTHENTICATION_FAILED = defineMessage({
  defaultMessage: "the provider rejected authentication or access",
});
const POST_PROCESSING_TIMED_OUT = defineMessage({
  defaultMessage: "the request timed out",
});
const REQUEST_ABORTED = defineMessage({
  defaultMessage: "the request was cancelled",
});
const NETWORK_ERROR = defineMessage({
  defaultMessage: "the provider could not be reached",
});
const PROVIDER_ERROR = defineMessage({
  defaultMessage: "the post-processing provider returned an error",
});

/**
 * The exact string each classifier branch returns, paired with the message the
 * user sees for it. Every descriptor is declared with `defineMessage` so the
 * i18n extractor can include it in the catalogs.
 */
export const POST_PROCESS_ERROR_REASONS: Readonly<
  Record<PostProcessErrorCategory, PostProcessErrorReason>
> = {
  [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment]: QUOTA_OR_PAYMENT,
  [POST_PROCESS_ERROR_CATEGORY.rateLimit]: RATE_LIMIT_EXCEEDED,
  [POST_PROCESS_ERROR_CATEGORY.providerLimit]: PROVIDER_LIMIT_REACHED,
  [POST_PROCESS_ERROR_CATEGORY.authentication]: AUTHENTICATION_FAILED,
  [POST_PROCESS_ERROR_CATEGORY.timedOut]: POST_PROCESSING_TIMED_OUT,
  [POST_PROCESS_ERROR_CATEGORY.aborted]: REQUEST_ABORTED,
  [POST_PROCESS_ERROR_CATEGORY.network]: NETWORK_ERROR,
  [POST_PROCESS_ERROR_CATEGORY.provider]: PROVIDER_ERROR,
};

/** Reused for missing or older stored categories. */
export const UNKNOWN_POST_PROCESS_ERROR_REASON: PostProcessErrorReason =
  PROVIDER_ERROR;

export const isPostProcessErrorCategory = (
  category: unknown,
): category is PostProcessErrorCategory =>
  typeof category === "string" &&
  Object.hasOwn(POST_PROCESS_ERROR_REASONS, category);

/** Resolve persisted categories without ever rendering unknown values verbatim. */
export const postProcessErrorReason = (
  category: string | null | undefined,
): PostProcessErrorReason =>
  (isPostProcessErrorCategory(category)
    ? POST_PROCESS_ERROR_REASONS[category]
    : undefined) || UNKNOWN_POST_PROCESS_ERROR_REASON;

type ErrorRecord = Record<string, unknown>;

const asRecord = (value: unknown): ErrorRecord | undefined =>
  typeof value === "object" && value !== null
    ? (value as ErrorRecord)
    : undefined;

const collectNestedProviderRecords = (error: unknown): ErrorRecord[] => {
  const outer = asRecord(error);
  const pending = [
    asRecord(outer?.fallbackCause),
    asRecord(outer?.primaryCause),
    asRecord(outer?.cause),
    asRecord(outer?.error),
    asRecord(outer?.response),
    asRecord(outer?.data),
    asRecord(outer?.metadata),
  ].filter((record): record is ErrorRecord => record !== undefined);
  const visited = new Set<ErrorRecord>();
  const records: ErrorRecord[] = [];

  for (let index = 0; index < pending.length; index += 1) {
    const record = pending[index];
    if (!record || visited.has(record)) continue;
    visited.add(record);
    records.push(record);
    pending.push(
      ...[
        "fallbackCause",
        "primaryCause",
        "cause",
        "error",
        "response",
        "data",
        "metadata",
      ]
        .map((key) => asRecord(record[key]))
        .filter((nested): nested is ErrorRecord => nested !== undefined),
    );
  }

  return records;
};

const collectProviderDetails = (
  error: unknown,
): {
  status: number | undefined;
  structured: string;
} => {
  const outer = asRecord(error);
  const nestedRecords = collectNestedProviderRecords(error);
  const structuredValues = [
    readProviderCode(error),
    outer?.type,
    outer?.name,
    outer?.reason,
    outer?.limit_source,
    ...nestedRecords.flatMap((record) => [
      readProviderCode(record),
      record.code,
      record.type,
      record.name,
      record.error_type,
      record.reason,
      record.limit_source,
    ]),
  ].filter((value): value is string => typeof value === "string");

  const nestedStatus = nestedRecords
    .map((record) => readProviderStatus(record))
    .find((status) => status !== undefined);

  return {
    status: readProviderStatus(error) ?? nestedStatus,
    structured: structuredValues.join(" ").toLowerCase(),
  };
};

const includesAny = (value: string, markers: readonly string[]): boolean =>
  markers.some((marker) => value.includes(marker));

const getErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  const messages = [
    asRecord(error)?.message,
    ...collectNestedProviderRecords(error).map((record) => record.message),
  ].filter((message): message is string => typeof message === "string");
  return messages.join(" ");
};

const OPENROUTER_IN_FLIGHT_BUDGET_MARKERS = [
  "openrouter_in_flight_budget",
  "in_flight_budget",
  "inflight_budget",
  "in-flight budget",
] as const;

const QUOTA_OR_BILLING_CODES = [
  "insufficient_quota",
  "quota_exceeded",
  "credit_balance_exhausted",
  "credits_exhausted",
  "billing_limit_exceeded",
  "billing_hard_limit_reached",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "spend_limit_exceeded",
  "monthly_spend_limit_exceeded",
  "payment_required",
] as const;

const RATE_LIMIT_CODES = [
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "too_many_requests",
  "requests_limit_exceeded",
] as const;

const AUTHENTICATION_CODES = [
  "invalid_api_key",
  "authentication_error",
  "unauthorized",
  "permission_denied",
  "forbidden",
] as const;

const QUOTA_OR_BILLING_MESSAGE_MARKERS = [
  "quota",
  "insufficient credit",
  "out of credit",
  "payment required",
  "billing limit",
  "spend limit",
  "spending limit",
  "spend cap",
  "credit balance",
] as const;

const RATE_LIMIT_MESSAGE_MARKERS = [
  "rate limit",
  "rate_limit",
  "too many requests",
] as const;

const STRUCTURED_TIMEOUT_CODES = [
  "etimedout",
  "esockettimedout",
  "timeout_error",
  "timeouterror",
] as const;
const STRUCTURED_ABORT_CODES = [
  "err_canceled",
  "abort_err",
  "aborterror",
  "apiuseraborterror",
  "aborted",
] as const;
const STRUCTURED_NETWORK_CODES = [
  "econnrefused",
  "econnreset",
  "enotfound",
  "eai_again",
  "network_error",
] as const;
const AUTHENTICATION_MESSAGE_MARKERS = [
  "401",
  "403",
  "unauthorized",
  "forbidden",
  "authentication",
  "permission denied",
] as const;
const TIMEOUT_MESSAGE_MARKERS = ["timeout", "timed out"] as const;
const ABORT_MESSAGE_MARKERS = ["abort", "cancelled", "canceled"] as const;
const NETWORK_MESSAGE_MARKERS = [
  "econnrefused",
  "econnreset",
  "enotfound",
  "network",
  "fetch failed",
] as const;

const classifyStructuredDetails = (
  structured: string,
): PostProcessErrorCategory | undefined => {
  if (includesAny(structured, OPENROUTER_IN_FLIGHT_BUDGET_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.providerLimit;
  }
  if (includesAny(structured, QUOTA_OR_BILLING_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
  }
  if (includesAny(structured, RATE_LIMIT_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.rateLimit;
  }
  if (includesAny(structured, AUTHENTICATION_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.authentication;
  }
  if (includesAny(structured, STRUCTURED_TIMEOUT_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.timedOut;
  }
  if (includesAny(structured, STRUCTURED_ABORT_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.aborted;
  }
  if (includesAny(structured, STRUCTURED_NETWORK_CODES)) {
    return POST_PROCESS_ERROR_CATEGORY.network;
  }
  return undefined;
};

const classifyStatus = (
  status: number | undefined,
  message: string,
): PostProcessErrorCategory | undefined => {
  switch (status) {
    case 402:
      return includesAny(message, OPENROUTER_IN_FLIGHT_BUDGET_MARKERS)
        ? POST_PROCESS_ERROR_CATEGORY.providerLimit
        : POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
    case 429:
      if (includesAny(message, OPENROUTER_IN_FLIGHT_BUDGET_MARKERS)) {
        return POST_PROCESS_ERROR_CATEGORY.providerLimit;
      }
      if (includesAny(message, QUOTA_OR_BILLING_MESSAGE_MARKERS)) {
        return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
      }
      if (includesAny(message, RATE_LIMIT_MESSAGE_MARKERS)) {
        return POST_PROCESS_ERROR_CATEGORY.rateLimit;
      }
      return POST_PROCESS_ERROR_CATEGORY.providerLimit;
    case 401:
    case 403:
      return POST_PROCESS_ERROR_CATEGORY.authentication;
    case 408:
    case 504:
      return POST_PROCESS_ERROR_CATEGORY.timedOut;
    default:
      return status !== undefined && status >= 500
        ? POST_PROCESS_ERROR_CATEGORY.provider
        : undefined;
  }
};

const classifyMessage = (message: string): PostProcessErrorCategory => {
  if (includesAny(message, OPENROUTER_IN_FLIGHT_BUDGET_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.providerLimit;
  }
  if (includesAny(message, QUOTA_OR_BILLING_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
  }
  if (includesAny(message, RATE_LIMIT_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.rateLimit;
  }
  if (includesAny(message, AUTHENTICATION_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.authentication;
  }
  if (includesAny(message, TIMEOUT_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.timedOut;
  }
  if (includesAny(message, ABORT_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.aborted;
  }
  if (includesAny(message, NETWORK_MESSAGE_MARKERS)) {
    return POST_PROCESS_ERROR_CATEGORY.network;
  }
  if (/\b429\b/.test(message)) {
    return POST_PROCESS_ERROR_CATEGORY.providerLimit;
  }
  if (/\b402\b/.test(message)) {
    return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
  }
  return POST_PROCESS_ERROR_CATEGORY.provider;
};

/**
 * Prefer provider status and machine-readable codes to prose. HTTP 429 is used
 * for several kinds of provider limits, so an unexplained 429 stays neutral.
 * In particular, an OpenRouter in-flight budget is not evidence that credits
 * expired or ran out.
 */
export const classifyPostProcessErrorCategory = (
  error: unknown,
  fallbackMessage?: string,
): PostProcessErrorCategory => {
  const { status, structured } = collectProviderDetails(error);
  const message = [fallbackMessage, getErrorMessage(error)]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();

  const structuredCategory = classifyStructuredDetails(structured);
  if (structuredCategory) return structuredCategory;

  const statusCategory = classifyStatus(status, message);
  if (statusCategory) return statusCategory;

  return classifyMessage(message);
};

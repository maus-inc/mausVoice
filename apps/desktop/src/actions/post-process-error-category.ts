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

/** The property names that carry a nested provider record on an error. */
const NESTED_PROVIDER_RECORD_KEYS = [
  "fallbackCause",
  "primaryCause",
  "cause",
  "error",
  "response",
  "data",
  "metadata",
] as const;

const collectNestedProviderRecords = (error: unknown): ErrorRecord[] => {
  const outer = asRecord(error);
  const pending = NESTED_PROVIDER_RECORD_KEYS.map((key) =>
    asRecord(outer?.[key]),
  ).filter((record): record is ErrorRecord => record !== undefined);
  const visited = new Set<ErrorRecord>();
  const records: ErrorRecord[] = [];

  // `pending` is a queue: the iterator visits children appended during the
  // walk, so one pass reaches every depth without recursion.
  for (const record of pending) {
    if (visited.has(record)) continue;
    visited.add(record);
    records.push(record);
    for (const key of NESTED_PROVIDER_RECORD_KEYS) {
      const nested = asRecord(record[key]);
      if (nested !== undefined) pending.push(nested);
    }
  }

  return records;
};

const collectProviderDetails = (
  error: unknown,
): {
  status: number | undefined;
  structuredFields: string[];
} => {
  const outer = asRecord(error);
  const nestedRecords = collectNestedProviderRecords(error);
  const structuredFields = [
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
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  const nestedStatus = nestedRecords
    .map((record) => readProviderStatus(record))
    .find((status) => status !== undefined);

  return {
    status: readProviderStatus(error) ?? nestedStatus,
    structuredFields,
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

type ClassificationRule = {
  markers: readonly string[];
  category: PostProcessErrorCategory;
};

/** First rule whose markers appear in the value wins. Order is the behaviour. */
const matchClassificationRules = (
  value: string,
  rules: readonly ClassificationRule[],
): PostProcessErrorCategory | undefined =>
  rules.find((rule) => includesAny(value, rule.markers))?.category;

// The structured cascade: provider codes and shape names beat prose. The
// in-flight budget check runs first everywhere it can appear, because a
// budget error is a request limit and not an expired balance.
const STRUCTURED_CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    markers: OPENROUTER_IN_FLIGHT_BUDGET_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.providerLimit,
  },
  {
    markers: QUOTA_OR_BILLING_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
  },
  {
    markers: RATE_LIMIT_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.rateLimit,
  },
  {
    markers: AUTHENTICATION_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.authentication,
  },
  {
    markers: STRUCTURED_TIMEOUT_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.timedOut,
  },
  {
    markers: STRUCTURED_ABORT_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.aborted,
  },
  {
    markers: STRUCTURED_NETWORK_CODES,
    category: POST_PROCESS_ERROR_CATEGORY.network,
  },
];

// Match each structured field on its own instead of a joined string. Markers
// with a space (the in-flight budget wording) would otherwise match across two
// unrelated fields, and a provider code must stay one token to mean anything.
const classifyStructuredDetails = (
  structuredFields: readonly string[],
): PostProcessErrorCategory | undefined =>
  STRUCTURED_CLASSIFICATION_RULES.find((rule) =>
    structuredFields.some((field) => includesAny(field, rule.markers)),
  )?.category;

const CATEGORY_BY_STATUS: ReadonlyMap<number, PostProcessErrorCategory> =
  new Map([
    [401, POST_PROCESS_ERROR_CATEGORY.authentication],
    [403, POST_PROCESS_ERROR_CATEGORY.authentication],
    [408, POST_PROCESS_ERROR_CATEGORY.timedOut],
    [504, POST_PROCESS_ERROR_CATEGORY.timedOut],
  ]);

const classifyPaymentRequiredStatus = (
  message: string,
): PostProcessErrorCategory =>
  includesAny(message, OPENROUTER_IN_FLIGHT_BUDGET_MARKERS)
    ? POST_PROCESS_ERROR_CATEGORY.providerLimit
    : POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;

const RATE_LIMITED_STATUS_RULES: readonly ClassificationRule[] = [
  {
    markers: OPENROUTER_IN_FLIGHT_BUDGET_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.providerLimit,
  },
  {
    markers: QUOTA_OR_BILLING_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
  },
  {
    markers: RATE_LIMIT_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.rateLimit,
  },
];

const classifyRateLimitedStatus = (message: string): PostProcessErrorCategory =>
  matchClassificationRules(message, RATE_LIMITED_STATUS_RULES) ??
  POST_PROCESS_ERROR_CATEGORY.providerLimit;

const classifyStatus = (
  status: number | undefined,
  message: string,
): PostProcessErrorCategory | undefined => {
  if (status === undefined) return undefined;
  if (status === 402) return classifyPaymentRequiredStatus(message);
  if (status === 429) return classifyRateLimitedStatus(message);
  if (status >= 500) return POST_PROCESS_ERROR_CATEGORY.provider;
  return CATEGORY_BY_STATUS.get(status);
};

// The prose cascade, run only when codes and status had nothing to say. The
// quota test runs ahead of the 401 wording on purpose: a billing failure can
// arrive as a 401 with `insufficient_quota` in the body. Timeout runs ahead
// of abort because a timed-out request is also an aborted one.
const MESSAGE_CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    markers: OPENROUTER_IN_FLIGHT_BUDGET_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.providerLimit,
  },
  {
    markers: QUOTA_OR_BILLING_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.quotaOrPayment,
  },
  {
    markers: RATE_LIMIT_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.rateLimit,
  },
  {
    markers: AUTHENTICATION_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.authentication,
  },
  {
    markers: TIMEOUT_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.timedOut,
  },
  {
    markers: ABORT_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.aborted,
  },
  {
    markers: NETWORK_MESSAGE_MARKERS,
    category: POST_PROCESS_ERROR_CATEGORY.network,
  },
];

const classifyMessage = (message: string): PostProcessErrorCategory => {
  const matched = matchClassificationRules(
    message,
    MESSAGE_CLASSIFICATION_RULES,
  );
  if (matched) return matched;
  if (/\b429\b/.test(message)) return POST_PROCESS_ERROR_CATEGORY.providerLimit;
  if (/\b402\b/.test(message))
    return POST_PROCESS_ERROR_CATEGORY.quotaOrPayment;
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
  const { status, structuredFields } = collectProviderDetails(error);
  const message = [fallbackMessage, getErrorMessage(error)]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();

  const structuredCategory = classifyStructuredDetails(structuredFields);
  if (structuredCategory) return structuredCategory;

  const statusCategory = classifyStatus(status, message);
  if (statusCategory) return statusCategory;

  return classifyMessage(message);
};

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMessageId } from "../../scripts/formatjs-id.mjs";
import en from "../i18n/locales/en.json";
import {
  classifyPostProcessErrorCategory,
  isPostProcessErrorCategory,
  POST_PROCESS_ERROR_CATEGORY,
  POST_PROCESS_ERROR_REASONS,
  type PostProcessErrorCategory,
  postProcessErrorReason,
  UNKNOWN_POST_PROCESS_ERROR_REASON,
} from "./post-process-error-category";

/**
 * One representative provider error per stored category. The record is typed
 * against the category union, so a new category needs both a branch input and
 * a localized reason before this test can compile.
 */
const BRANCH_ERRORS: Readonly<Record<PostProcessErrorCategory, unknown>> = {
  [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment]: { status: 402 },
  [POST_PROCESS_ERROR_CATEGORY.rateLimit]: {
    status: 429,
    code: "rate_limit_exceeded",
  },
  [POST_PROCESS_ERROR_CATEGORY.providerLimit]: { status: 429 },
  [POST_PROCESS_ERROR_CATEGORY.authentication]: { status: 401 },
  [POST_PROCESS_ERROR_CATEGORY.timedOut]: { status: 408 },
  [POST_PROCESS_ERROR_CATEGORY.aborted]: { code: "ERR_CANCELED" },
  [POST_PROCESS_ERROR_CATEGORY.network]: { code: "ECONNREFUSED" },
  [POST_PROCESS_ERROR_CATEGORY.provider]: { status: 503 },
};

describe("classifyPostProcessErrorCategory", () => {
  it("returns exactly the categories that have a localized reason", () => {
    const returned = new Set(
      Object.values(BRANCH_ERRORS).map((error) =>
        classifyPostProcessErrorCategory(error),
      ),
    );

    expect([...returned].sort()).toEqual(Object.keys(BRANCH_ERRORS).sort());
  });

  it("has a descriptor for every stored category", () => {
    for (const category of Object.values(POST_PROCESS_ERROR_CATEGORY)) {
      expect(POST_PROCESS_ERROR_REASONS[category]).toBeDefined();
    }
  });

  it("uses a structured quota code before an ambiguous 429 status", () => {
    expect(
      classifyPostProcessErrorCategory({
        status: 429,
        code: "insufficient_quota",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
  });

  it("reads a specific nested code when an SDK wrapper has a generic code", () => {
    expect(
      classifyPostProcessErrorCategory({
        status: 429,
        code: "ERR_BAD_REQUEST",
        error: { code: "insufficient_quota" },
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
  });

  it("classifies structured errors kept inside a provider fallback chain", () => {
    const error = Object.assign(new Error("Both provider models failed"), {
      primaryCause: { status: 404, code: "model_not_found" },
      fallbackCause: { status: 429, code: "rate_limit_exceeded" },
    });

    expect(classifyPostProcessErrorCategory(error)).toBe(
      POST_PROCESS_ERROR_CATEGORY.rateLimit,
    );
  });

  it("classifies abort and timeout names when error messages are empty", () => {
    expect(
      classifyPostProcessErrorCategory(new DOMException("", "AbortError")),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.aborted);
    expect(
      classifyPostProcessErrorCategory(new DOMException("", "TimeoutError")),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.timedOut);
  });

  it("prefers a structured code over conflicting message text", () => {
    expect(
      classifyPostProcessErrorCategory({
        status: 429,
        code: "rate_limit_exceeded",
        message: "OpenRouter in-flight budget exhausted",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.rateLimit);
  });

  it("keeps an unexplained 429 neutral instead of calling it a rate limit", () => {
    expect(classifyPostProcessErrorCategory({ status: 429 })).toBe(
      POST_PROCESS_ERROR_CATEGORY.providerLimit,
    );
  });

  it("uses a nested provider message when a wrapper has only the HTTP status", () => {
    const error = Object.assign(new Error("Provider request failed"), {
      status: 429,
      error: { message: "The account quota has been exhausted." },
    });

    expect(
      classifyPostProcessErrorCategory(error, "Provider request failed"),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
  });

  it("uses explicit 429 message details only when the status and code are ambiguous", () => {
    expect(
      classifyPostProcessErrorCategory({
        status: 429,
        message: "The account quota has been exhausted.",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
    expect(
      classifyPostProcessErrorCategory({
        status: 429,
        message: "Too many requests; retry later.",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.rateLimit);
  });

  it("recognizes OpenRouter's transient in-flight budget before quota wording", () => {
    expect(
      classifyPostProcessErrorCategory({
        status: 402,
        error: {
          code: "insufficient_quota",
          metadata: { limit_source: "openrouter_in_flight_budget" },
        },
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.providerLimit);
    expect(
      classifyPostProcessErrorCategory({
        status: 402,
        cause: {
          error: {
            code: "insufficient_quota",
            reason: "in_flight_budget_exhausted",
            metadata: { limit_source: "openrouter_in_flight_budget" },
          },
        },
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.providerLimit);
    expect(
      classifyPostProcessErrorCategory({
        status: 402,
        message: "OpenRouter in-flight budget exhausted",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.providerLimit);
  });

  it("does not match a spaced marker across two separate structured fields", () => {
    // Joined, these two fields read "...in-flight budget...", but each field on
    // its own carries no budget marker, so they must not classify as a limit.
    expect(
      classifyPostProcessErrorCategory({
        code: "x in-flight",
        type: "budget y",
      }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.provider);
    // A marker that genuinely sits inside one field still matches.
    expect(
      classifyPostProcessErrorCategory({ code: "hit in-flight budget cap" }),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.providerLimit);
  });

  it("falls back to explicit message text when no structured fields are present", () => {
    expect(
      classifyPostProcessErrorCategory("402 payment required, quota exhausted"),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
    expect(classifyPostProcessErrorCategory("429 too many requests")).toBe(
      POST_PROCESS_ERROR_CATEGORY.rateLimit,
    );
  });

  it("reads timeout before abort so a deadline is not reported as a cancel", () => {
    expect(
      classifyPostProcessErrorCategory("the request timed out and was aborted"),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.timedOut);
  });
});

describe("postProcessErrorReason", () => {
  it("recognizes stored categories without claiming arbitrary warning text", () => {
    for (const category of Object.values(POST_PROCESS_ERROR_CATEGORY)) {
      expect(isPostProcessErrorCategory(category)).toBe(true);
    }
    expect(isPostProcessErrorCategory("The response was truncated")).toBe(
      false,
    );
  });

  it("resolves a stored category to its message", () => {
    expect(
      postProcessErrorReason(POST_PROCESS_ERROR_CATEGORY.rateLimit)
        .defaultMessage,
    ).toBe("the provider rate limit was reached");
  });

  it("falls back for a category an older build wrote", () => {
    // The value is read back from the database, so it can be any string a
    // previous version of the classifier produced. Rendering an unknown value
    // verbatim would put a stale internal string in the toast.
    expect(
      postProcessErrorReason("Some category removed two releases ago")
        .defaultMessage,
    ).toBe("the post-processing provider returned an error");
  });

  it("falls back for a missing category", () => {
    expect(postProcessErrorReason(null).defaultMessage).toBe(
      "the post-processing provider returned an error",
    );
    expect(postProcessErrorReason(undefined).defaultMessage).toBe(
      "the post-processing provider returned an error",
    );
    expect(postProcessErrorReason("").defaultMessage).toBe(
      "the post-processing provider returned an error",
    );
  });

  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__proto__",
  ])("falls back for the inherited key %s", (key) => {
    // These are the names `POST_PROCESS_ERROR_REASONS` inherits from
    // `Object.prototype`. A plain `[category]` lookup returns the inherited
    // member, which is truthy, so the `||` never reaches the fallback and the
    // function hands back a function where a message descriptor is declared.
    // The caller passes that to `formatMessage`, which throws on a missing id
    // and takes the styling-failure toast down with it.
    expect(postProcessErrorReason(key)).toBe(UNKNOWN_POST_PROCESS_ERROR_REASON);
  });

  it("returns a descriptor and never a function, for any stored string", () => {
    // The property the defect turns on: the declared return type holds for
    // every input, not just for the inputs that happen not to collide with the
    // prototype.
    for (const value of [
      POST_PROCESS_ERROR_CATEGORY.network,
      "constructor",
      "toString",
      "some string an older build wrote",
    ]) {
      const reason: unknown = postProcessErrorReason(value);
      expect(typeof reason).toBe("object");
      expect(reason).not.toBeNull();
      expect(
        typeof (reason as { defaultMessage?: unknown }).defaultMessage,
      ).toBe("string");
    }
  });
});

describe("catalog coverage", () => {
  /**
   * Every descriptor the toast can render, in the order the table above plus
   * the fallback. The fallback is a `defineMessage` descriptor rather than an
   * object literal precisely so it is one of these; including it here is what
   * keeps that true.
   */
  const descriptors = [
    ...Object.values(POST_PROCESS_ERROR_REASONS),
    UNKNOWN_POST_PROCESS_ERROR_REASON,
  ];

  it("reaches the fallback as a descriptor and not a hand written literal", () => {
    // Object identity, not equality: a fresh `{ defaultMessage }` literal
    // compares deep-equal while still carrying no `id`, which is the defect
    // this test exists to catch.
    expect(UNKNOWN_POST_PROCESS_ERROR_REASON).toBe(
      POST_PROCESS_ERROR_REASONS[POST_PROCESS_ERROR_CATEGORY.provider],
    );
  });

  it("has an en.json entry for every descriptor", () => {
    // A descriptor whose id never reached the extractor throws inside
    // `formatMessage` at render time, so the toast explaining a styling failure
    // is the thing that breaks. `createMessageId` is the same derivation the
    // formatjs babel plugin applies, so this is the exact catalog key.
    const missing = descriptors
      .map((descriptor) => createMessageId(descriptor.defaultMessage))
      .filter((id) => !(id in en));
    expect(missing).toEqual([]);
  });

  it("declares no reason as an inline literal the build cannot annotate", () => {
    // The identity check above pins the fallback specifically. This one covers
    // the general form of the same defect, so a reason added later as a bare
    // `{ defaultMessage }` literal is caught before it ships rather than after.
    //
    // A catalog lookup cannot catch it, which is why the source is read here:
    // `createMessageId` derives the same key from a literal's text whether or
    // not the formatjs transform ever annotated it, so a literal passes the
    // check above while still throwing in the app. The property that
    // distinguishes them is that a literal is an object expression, and the
    // transform only reaches the ones built by a `defineMessage` call. The
    // babel plugin is not loaded under a unit test run, so this asserts
    // against the same source the plugin transforms.
    const source = ts.createSourceFile(
      "post-process-error-category.ts",
      readFileSync(
        fileURLToPath(
          new URL("./post-process-error-category.ts", import.meta.url),
        ),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
    );

    // Whitespace is stripped before comparing. The record annotation is wrapped
    // across three lines by the formatter, so an exact-text match on the
    // single-line form never matches it and the guard silently reads nothing.
    // The same matcher failing the other way is worse: the day the annotation
    // does fit on one line, an exact match would start matching and the check
    // would pass or fail on line breaks alone.
    const isReasonType = (node: ts.TypeNode): boolean => {
      const text = node.getText(source).replace(/\s+/g, "");
      return (
        text === "PostProcessErrorReason" ||
        text ===
          "Readonly<Record<PostProcessErrorCategory,PostProcessErrorReason>>"
      );
    };

    /**
     * A reason entry is safe only when it names a category constant and points
     * at a descriptor identifier. A key written as a bare string drifts from
     * `POST_PROCESS_ERROR_CATEGORY`, the one place the classifier returns are
     * defined, and a value written inline is the literal defect above.
     */
    const isCategoryKeyedDescriptor = (
      property: ts.ObjectLiteralElementLike,
    ): boolean =>
      ts.isPropertyAssignment(property) &&
      ts.isComputedPropertyName(property.name) &&
      ts.isPropertyAccessExpression(property.name.expression) &&
      property.name.expression.expression.getText(source) ===
        "POST_PROCESS_ERROR_CATEGORY" &&
      ts.isIdentifier(property.initializer);

    const literals: string[] = [];
    const unkeyed: string[] = [];
    let reasonRecords = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.type &&
        node.initializer &&
        isReasonType(node.type) &&
        ts.isIdentifier(node.name) &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        reasonRecords += 1;
        for (const property of node.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            literals.push(node.name.text);
            continue;
          }
          if (!isCategoryKeyedDescriptor(property)) {
            unkeyed.push(node.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // A guard that matches nothing passes. Pin that it read the descriptor
    // table, so a matcher regression fails here instead of quietly widening
    // coverage to nothing.
    expect(reasonRecords).toBeGreaterThan(0);
    expect(literals).toEqual([]);
    expect(unkeyed).toEqual([]);
  });
});

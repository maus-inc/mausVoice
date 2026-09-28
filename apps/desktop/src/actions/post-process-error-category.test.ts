import { describe, expect, it } from "vitest";
import {
  classifyPostProcessErrorCategory,
  POST_PROCESS_ERROR_CATEGORY,
  POST_PROCESS_ERROR_REASONS,
  postProcessErrorReason,
} from "./post-process-error-category";

/**
 * One representative provider message per classifier branch. The list is the
 * contract the table below is checked against, so a branch added to the
 * classifier without a message fails here instead of printing an internal
 * English string into a translated locale.
 */
const BRANCH_MESSAGES: Readonly<Record<string, string>> = {
  [POST_PROCESS_ERROR_CATEGORY.quotaOrPayment]: "402 payment required",
  [POST_PROCESS_ERROR_CATEGORY.rateLimit]: "429 rate limit",
  [POST_PROCESS_ERROR_CATEGORY.authentication]: "401 unauthorized",
  [POST_PROCESS_ERROR_CATEGORY.timedOut]: "the request timed out",
  [POST_PROCESS_ERROR_CATEGORY.aborted]: "the request was aborted",
  [POST_PROCESS_ERROR_CATEGORY.network]: "fetch failed",
  [POST_PROCESS_ERROR_CATEGORY.provider]:
    "something the classifier cannot place",
};

describe("classifyPostProcessErrorCategory", () => {
  it("returns exactly the categories that have a localized reason", () => {
    const returned = new Set(
      Object.values(BRANCH_MESSAGES).map((message) =>
        classifyPostProcessErrorCategory(message),
      ),
    );

    expect([...returned].sort()).toEqual(Object.keys(BRANCH_MESSAGES).sort());
  });

  it("has a descriptor for every classifier branch", () => {
    for (const category of Object.keys(BRANCH_MESSAGES)) {
      expect(POST_PROCESS_ERROR_REASONS[category]).toBeDefined();
    }
  });

  it("reads 402 before 401 so a billing body is not classified as auth", () => {
    // Order is the whole point of the classifier. Some providers put "quota" in
    // a body that also carries a 401, and the wrong branch sends the user to
    // fix their key instead of their balance.
    expect(
      classifyPostProcessErrorCategory("402 payment required, quota exhausted"),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.quotaOrPayment);
  });

  it("reads timeout before abort so a deadline is not reported as a cancel", () => {
    // The provider SDKs phrase a timed-out request as an abort, so checking
    // abort first would report every timeout as something the user cancelled.
    expect(
      classifyPostProcessErrorCategory("the request timed out and was aborted"),
    ).toBe(POST_PROCESS_ERROR_CATEGORY.timedOut);
  });
});

describe("postProcessErrorReason", () => {
  it("resolves a stored category to its message", () => {
    expect(
      postProcessErrorReason(POST_PROCESS_ERROR_CATEGORY.rateLimit)
        .defaultMessage,
    ).toBe("Rate limit exceeded");
  });

  it("falls back for a category an older build wrote", () => {
    // The value is read back from the database, so it can be any string a
    // previous version of the classifier produced. Rendering an unknown value
    // verbatim would put a stale internal string in the toast.
    expect(
      postProcessErrorReason("Some category removed two releases ago"),
    ).toEqual({ defaultMessage: "Provider error" });
  });

  it("falls back for a missing category", () => {
    expect(postProcessErrorReason(null)).toEqual({
      defaultMessage: "Provider error",
    });
    expect(postProcessErrorReason(undefined)).toEqual({
      defaultMessage: "Provider error",
    });
    expect(postProcessErrorReason("")).toEqual({
      defaultMessage: "Provider error",
    });
  });
});

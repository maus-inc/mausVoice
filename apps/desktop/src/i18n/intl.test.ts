import { describe, expect, it } from "vitest";
import { getIntl } from "./intl";

describe("getIntl outside React", () => {
  it("returns the default message for an id-less descriptor", () => {
    expect(
      getIntl("en").formatMessage({ defaultMessage: "Copied successfully" }),
    ).toBe("Copied successfully");
  });

  it("interpolates values into an id-less descriptor", () => {
    const formatted = getIntl("en").formatMessage(
      { defaultMessage: "{kept} of {total} characters kept." },
      { kept: 15000, total: 19321 },
    );
    expect(formatted).toBe("15000 of 19321 characters kept.");
  });

  it("never leaks a raw ICU placeholder to the user", () => {
    const formatted = getIntl("en").formatMessage(
      { defaultMessage: "{kept} of {total} characters kept." },
      { kept: 15000, total: 19321 },
    );
    expect(formatted).not.toContain("{");
  });

  it("reports a formatting failure instead of hiding it behind a bare string", () => {
    // The wrapper used to catch every error and return `defaultMessage ?? ""`,
    // so a missing value reached the user as the raw template with nothing
    // logged anywhere. `react-intl` already reports the failure through its own
    // `onError` and falls back to the verbatim default, so the wrapper must let
    // that happen rather than intercepting it.
    const reported: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => reported.push(args[0]);
    let formatted = "";
    try {
      formatted = getIntl("en").formatMessage(
        { defaultMessage: "{kept} of {total} characters kept." },
        { kept: 15000 },
      );
    } finally {
      console.error = originalError;
    }

    expect(reported).not.toHaveLength(0);
    expect(formatted).toBe("{kept} of {total} characters kept.");
  });
});

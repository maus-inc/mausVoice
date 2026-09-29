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
});

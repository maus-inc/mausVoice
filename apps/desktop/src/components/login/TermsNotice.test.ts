import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./TermsNotice.tsx", import.meta.url),
  "utf8",
);

describe("TermsNotice legal-link contract", () => {
  it("does not present the Code of Conduct as a privacy policy", () => {
    expect(source).toContain("Terms & Conditions");
    expect(source).not.toContain("Privacy Policy");
    expect(source).not.toContain("CODE_OF_CONDUCT");
  });
});

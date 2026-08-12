import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", () => ({
  FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
    defaultMessage,
}));

import { TermsNotice } from "./TermsNotice";

describe("TermsNotice legal-link contract", () => {
  it("renders only the available terms document", () => {
    const html = renderToStaticMarkup(createElement(TermsNotice));

    expect(html).toContain("Terms");
    expect(html).toContain("LICENCE");
    expect(html).not.toContain("Privacy Policy");
    expect(html).not.toContain("CODE_OF_CONDUCT");
  });
});

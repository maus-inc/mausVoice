import { createIntl, createIntlCache } from "react-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import en from "../../i18n/locales/en.json";
import { API_KEY_WARNING_CODES } from "../../utils/user.utils";
import { buildTranscriptionWarnings } from "./transcription-details-copy";

describe("buildTranscriptionWarnings", () => {
  it("localizes every structured API key warning code", () => {
    const intl = createIntl({ locale: "en", messages: en }, createIntlCache());

    const warnings = buildTranscriptionWarnings(
      {
        warnings: Object.values(API_KEY_WARNING_CODES),
      } as never,
      intl,
    );

    expect(warnings).toHaveLength(6);
    for (const warning of warnings) {
      expect(warning).not.toMatch(/^api_key_/);
      expect(warning).toContain("AI Models settings");
    }
  });
});

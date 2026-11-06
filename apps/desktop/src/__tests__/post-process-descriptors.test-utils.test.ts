import { describe, expect, it } from "vitest";
import { inspectPostProcessDescriptors } from "./post-process-descriptors.test-utils";

const source = (descriptor: string, record: string, fallback = "GOOD") => `
  import { defineMessage } from "react-intl";
  const GOOD = defineMessage({ defaultMessage: "safe" });
  ${descriptor}
  const REASONS: Readonly<Record<string, PostProcessErrorReason>> = ${record};
  const FALLBACK: PostProcessErrorReason = ${fallback};
`;

describe("post-processing descriptor source contract", () => {
  it("accepts only category-keyed, formatjs-visible descriptors", () => {
    expect(
      inspectPostProcessDescriptors(
        source("", "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }"),
      ),
    ).toEqual({ records: 1, errors: [] });
  });

  it("rejects an identifier that points to an unannotated literal", () => {
    const result = inspectPostProcessDescriptors(
      source(
        'const BAD = { defaultMessage: "bad" };',
        "{ [POST_PROCESS_ERROR_CATEGORY.provider]: BAD }",
      ),
    );
    expect(result.errors).toContain(
      "REASONS: descriptor BAD is not declared by defineMessage",
    );
  });

  it("rejects a dynamically produced or spread descriptor table", () => {
    expect(
      inspectPostProcessDescriptors(source("", "buildReasons()")).errors,
    ).toContain("REASONS: expected an object literal");
    expect(
      inspectPostProcessDescriptors(source("", "{ ...other }")).errors,
    ).toContain("REASONS: expected a category-keyed descriptor");
  });

  it("rejects unannotated fallback aliases and literals", () => {
    expect(
      inspectPostProcessDescriptors(
        source(
          'const BAD = { defaultMessage: "bad" };',
          "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }",
          "BAD",
        ),
      ).errors,
    ).toContain("FALLBACK: descriptor BAD is not declared by defineMessage");
    expect(
      inspectPostProcessDescriptors(
        source(
          "",
          "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }",
          '{ defaultMessage: "bad" }',
        ),
      ).errors,
    ).toContain("FALLBACK: expected a declared descriptor");
  });

  it("rejects defineMessage calls the extractor cannot statically annotate", () => {
    for (const expression of [
      "defineMessage(input)",
      "defineMessage({ defaultMessage: dynamicText })",
      'defineMessage({ defaultMessage: "safe", ...other })',
      'defineMessage({ defaultMessage: "safe", [key]: other })',
      "defineMessage({ id: 'only-id' })",
    ]) {
      const input = source(
        "",
        "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }",
      ).replace('defineMessage({ defaultMessage: "safe" })', expression);
      expect(inspectPostProcessDescriptors(input).errors).toContain(
        "REASONS: descriptor GOOD is not declared by defineMessage",
      );
    }
  });

  it("rejects type-only defineMessage imports", () => {
    const input = source(
      "",
      "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }",
    ).replace("import { defineMessage }", "import type { defineMessage }");
    expect(inspectPostProcessDescriptors(input).errors).toContain(
      "defineMessage must be imported from react-intl",
    );
  });

  it("fails closed when defineMessage is not imported from react-intl", () => {
    const input = source(
      "",
      "{ [POST_PROCESS_ERROR_CATEGORY.provider]: GOOD }",
    ).replace('from "react-intl"', 'from "other"');
    expect(inspectPostProcessDescriptors(input).errors).toContain(
      "defineMessage must be imported from react-intl",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  findProhibitedProductionDash,
  scanLocaleCatalog,
  scanSourceDashes,
} from "./ui-lint.mjs";

describe("ui-lint production dash guardrails", () => {
  it("flags em dashes, horizontal bars, HTML dash entities, and non-range en dashes", () => {
    expect(
      findProhibitedProductionDash("Imported from Voquill \u2014 action needed"),
    ).toBe("\u2014");
    expect(findProhibitedProductionDash("Status \u2015 failed")).toBe("\u2015");
    expect(findProhibitedProductionDash("Copy &mdash; now")).toBe("&mdash;");
    expect(findProhibitedProductionDash("Copy &ndash; now")).toBe("&ndash;");
    expect(findProhibitedProductionDash("Copy &#8212; now")).toBe("&#8212;");
    expect(findProhibitedProductionDash("Copy &#x2014; now")).toBe("&#x2014;");
    expect(findProhibitedProductionDash("Clause \u2013 separator")).toBe(
      "\u2013",
    );
    expect(findProhibitedProductionDash("\u2013 leading en dash")).toBe(
      "\u2013",
    );
  });

  it("allows standard hyphens and compact numeric ranges", () => {
    expect(findProhibitedProductionDash("1\u20133 sentences")).toBeNull();
    expect(findProhibitedProductionDash("Re-enter API key")).toBeNull();
    expect(
      findProhibitedProductionDash("Imported from Voquill. Action needed."),
    ).toBeNull();
  });

  it("catches prohibited dashes in string literals, unicode escapes, template literals, and JSX text", () => {
    const tsx = `
      export const Demo = ({ name }: { name: string }) => (
        <div>
          <FormattedMessage defaultMessage="Imported \u2014 skipped" />
          <FormattedMessage defaultMessage={"Escaped \\u2014 dash"} />
          <FormattedMessage defaultMessage="Entity &mdash; dash" />
          <span>{\`Status \u2013 \${name}\`}</span>
          <p>Inline &mdash; entity</p>
        </div>
      );
    `;
    const issues = scanSourceDashes("components/Demo.tsx", tsx);
    expect(issues).toHaveLength(5);
    for (const issue of issues) {
      expect(issue).toContain("prohibited dash");
    }
  });

  it("ignores comments, regex literals, and FormattedMessage translator descriptions", () => {
    const tsx = `
      // Comment with an em dash \u2014 allowed
      /* Block comment \u2014 allowed */
      export const clean = (s: string) => s.replace(/[-\u2013\u2014]+/g, "");
      export const View = () => (
        <div>
          {/* JSX comment \u2014 allowed */}
          <FormattedMessage
            defaultMessage="1\u20133 sentences"
            description="Translator note \u2014 never rendered"
          />
        </div>
      );
    `;
    expect(scanSourceDashes("components/Clean.tsx", tsx)).toEqual([]);
  });

  it("catches prohibited dashes in locale catalog messages", () => {
    const issues = scanLocaleCatalog("i18n/locales/en.json", {
      ok_range: "1\u20133 sentences",
      bad_em: "Imported \u2014 action needed",
      bad_en: "Dangerous \u2013 commands run as you",
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("bad_em");
    expect(issues[1]).toContain("bad_en");
  });
});

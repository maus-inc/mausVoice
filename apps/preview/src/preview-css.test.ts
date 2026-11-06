// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the preview mount filling the viewport without an ID-specific layout rule", () => {
  const markup = new DOMParser().parseFromString(
    readFileSync("index.html", "utf8"),
    "text/html",
  );
  const root = markup.getElementById("root")!;
  const style = document.createElement("style");
  style.textContent = readFileSync("src/preview.css", "utf8").replace(
    /@import[^;]+;/,
    "",
  );
  document.head.append(style);
  document.body.append(root);
  try {
    expect(root.classList.contains("preview-root")).toBe(true);
    expect(getComputedStyle(root).height).toBe("100%");
  } finally {
    style.remove();
    root.remove();
  }
});

it("scopes code-block chrome without changing inline-code styling", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/preview.css", "utf8").replace(
    /@import[^;]+;/,
    "",
  );
  document.head.append(style);
  try {
    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    const find = (selector: string) => {
      const rule = rules.find((entry) => entry.selectorText === selector);
      expect(rule, `missing ${selector}`).toBeDefined();
      return rule!.style;
    };
    const code = find(".preview-markdown code");
    const pre = find(".preview-markdown pre");
    expect(code.getPropertyValue("background")).toBe(
      "var(--mv-preview-code-background, var(--app-palette-level2))",
    );
    expect(code.getPropertyValue("padding")).toBe(
      "var(--mv-preview-code-padding, 1px 5px)",
    );
    expect(pre.getPropertyValue("--mv-preview-code-background")).toBe("none");
    expect(pre.getPropertyValue("--mv-preview-code-padding")).toBe("0");
    expect(pre.getPropertyValue("background")).toBe(
      "var(--app-palette-level2)",
    );
    expect(pre.getPropertyValue("padding")).toBe("12px");
  } finally {
    style.remove();
  }
});

it("shares one scoped prose size across preview paragraphs and list items", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/preview.css", "utf8").replace(
    /@import[^;]+;/,
    "",
  );
  document.head.append(style);
  try {
    const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
    const root = rules.find(
      (rule) => rule.selectorText === ".preview-markdown",
    );
    const prose = rules.find(
      (rule) =>
        rule.selectorText?.replace(/\s+/g, " ").trim() ===
        ".preview-markdown p, .preview-markdown li",
    );
    expect(root?.style.getPropertyValue("--mv-preview-prose-size").trim()).toBe(
      "13.5px",
    );
    expect(prose?.style.fontSize).toBe("var(--mv-preview-prose-size)");
  } finally {
    style.remove();
  }
});

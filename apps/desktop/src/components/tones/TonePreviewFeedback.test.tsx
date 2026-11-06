import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { TonePreviewFeedback } from "./TonePreviewFeedback";

const render = (props: Partial<Parameters<typeof TonePreviewFeedback>[0]>) =>
  renderToStaticMarkup(
    createElement(TonePreviewFeedback, {
      status: "idle",
      output: "sample output",
      error: "provider error",
      ...props,
    }),
  );

describe("TonePreviewFeedback", () => {
  it("renders only the relevant preview state", () => {
    expect(render({})).toBe("");
    expect(render({ status: "running" })).toContain("Styling the sample...");
    expect(render({ status: "done" })).toContain("sample output");
    expect(render({ status: "error" })).toContain("Preview failed.");
    expect(render({ status: "error" })).toContain("provider error");
  });

  it("shows the create-only guidance for an unavailable provider", () => {
    const edit = render({ status: "unavailable" });
    const create = render({
      status: "unavailable",
      canCreateWithoutPreview: true,
    });
    expect(edit).toContain("No text-generation provider is configured");
    expect(edit).not.toContain("You can create this style without a preview");
    expect(create).toContain("No text-generation provider is configured");
    expect(create).toContain("You can create this style without a preview");
  });
});

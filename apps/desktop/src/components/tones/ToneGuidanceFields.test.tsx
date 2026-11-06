// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ToneExampleField, ToneOutputLengthField } from "./ToneGuidanceFields";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const Guidance = () => {
  const [length, setLength] = useState("");
  const [example, setExample] = useState("");
  return (
    <>
      <ToneOutputLengthField value={length} onChange={setLength} />
      <ToneExampleField value={example} onChange={setExample} />
    </>
  );
};

describe("tone guidance fields", () => {
  it("updates each value and displays the corresponding character limit", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Guidance />));
      const input = container.querySelector<HTMLInputElement>(
        'input[placeholder="1–3 sentences"]',
      )!;
      const example = container.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Input: ... Output: ..."]',
      )!;
      expect(input.maxLength).toBe(120);
      expect(example.maxLength).toBe(1200);
      const change = async (
        element: HTMLInputElement | HTMLTextAreaElement,
        value: string,
      ) => {
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        await act(async () => {
          Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
            element,
            value,
          );
          element.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
      await change(input, "brief");
      await change(example, "hello");
      expect(input.value).toBe("brief");
      expect(example.value).toBe("hello");
      expect(container.textContent).toContain("5/120");
      expect(container.textContent).toContain("5/1200");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

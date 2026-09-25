// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn(),
  onSend: vi.fn(),
  showError: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../actions/chat.actions", () => ({
  sendChatMessage: mocks.send,
  abortAgent: mocks.abort,
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showError,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: mocks.logError }),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
import { ChatPromptBox } from "./ChatPromptBox";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send
    .mockReset()
    .mockImplementation(
      async (_id: string, _text: string, onPersisted?: () => void) =>
        onPersisted?.(),
    );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = async (running: boolean) => {
  await act(async () =>
    root.render(
      createElement(ChatPromptBox, {
        conversationId: "chat",
        running,
        onSend: mocks.onSend,
      }),
    ),
  );
  return container.querySelector("input")!;
};
const type = async (input: HTMLInputElement, text = "draft") => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pressEnter = async (input: HTMLInputElement) => {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
};
describe("ChatPromptBox", () => {
  it("keeps a translated accessible name on the actual input after typing", async () => {
    const input = await render(false);
    await type(input);
    expect(input.value).toBe("draft");
    expect(input.getAttribute("aria-label")).toBe("Type a message…");
  });
  it("blocks Enter while an agent runs and allows it after the run stops", async () => {
    const input = await render(true);
    await type(input);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(mocks.send).not.toHaveBeenCalled();
    await render(false);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(mocks.send.mock.calls[0].slice(0, 2)).toEqual(["chat", "draft"]);
  });
  it("retains an unsaved draft, reports storage failure and permits retry", async () => {
    const input = await render(false);
    await type(input);
    const error = new Error("storage failed: private transcript and token");
    mocks.send.mockRejectedValueOnce(error);
    await pressEnter(input);
    expect(input.value).toBe("draft");
    expect(mocks.showError).toHaveBeenCalledWith(error);
    expect(mocks.logError.mock.calls).toEqual([["Failed to send message"]]);
    expect(mocks.onSend).not.toHaveBeenCalled();
    await pressEnter(input);
    expect(input.value).toBe("");
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "clears only the persisted draft, before generation ends (edited=%s)",
    async (edited) => {
      let acknowledge!: () => void;
      let finish!: () => void;
      mocks.send.mockImplementationOnce(
        (_id: string, _text: string, callback: () => void) => {
          acknowledge = callback;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      );
      const input = await render(false);
      await type(input);
      await pressEnter(input);
      expect(input.value).toBe("draft");
      expect(mocks.onSend).not.toHaveBeenCalled();
      if (edited) await type(input, "next draft");
      await act(async () => acknowledge());
      expect(input.value).toBe(edited ? "next draft" : "");
      expect(mocks.onSend).toHaveBeenCalledWith("draft");
      await type(input, "next draft");
      await act(async () => finish());
      expect(input.value).toBe("next draft");
    },
  );
  it("does not restore a persisted draft when agent setup fails", async () => {
    mocks.send.mockImplementationOnce(
      async (_id: string, _text: string, saved: () => void) => {
        saved();
        throw new Error("No provider configured");
      },
    );
    const input = await render(false);
    await type(input);
    await pressEnter(input);
    expect(input.value).toBe("");
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.showError).toHaveBeenCalledTimes(1);
  });
  it("reserves the send synchronously against duplicate Enter events", async () => {
    const input = await render(false);
    await type(input);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

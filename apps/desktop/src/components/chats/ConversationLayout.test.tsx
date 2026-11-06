// @vitest-environment jsdom
import { act, type ReactNode, type Ref, type UIEventHandler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import de from "../../i18n/locales/de.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  error: vi.fn(),
  showError: vi.fn(),
}));
vi.mock("../../actions/chat.actions", () => ({ sendChatMessage: mocks.send }));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showError,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ error: mocks.error }),
}));
vi.mock("../onboarding/TipCard", () => ({ TipCard: () => null }));
vi.mock("./ChatPromptBox", () => ({ ChatPromptBox: () => null }));
vi.mock("./ChatMessageBubble", () => ({ ChatMessageBubble: () => null }));
vi.mock("./ToolPermissionCard", () => ({ ToolPermissionCard: () => null }));
vi.mock("../common/FadingScrollArea", () => ({
  FadingScrollArea: ({
    children,
    viewportRef,
    onScroll,
  }: {
    children: ReactNode;
    viewportRef: Ref<HTMLDivElement>;
    onScroll: UIEventHandler<HTMLDivElement>;
  }) => (
    <div data-testid="viewport" ref={viewportRef} onScroll={onScroll}>
      {children}
    </div>
  ),
}));
// Supply build-time IDs while exercising real Intl formatting/catalogs.
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { ConversationLayout } from "./ConversationLayout";
import { ToolResultPart, ToolStepPart } from "./ChatMessageParts";
ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (child: ReactNode, messages: Record<string, string> = de) =>
  act(async () => {
    root.render(
      <IntlProvider locale="de" messages={messages}>
        {child}
      </IntlProvider>,
    );
  });
it.each([
  ["polish_my_last_dictation", "Mein letztes Diktat überarbeiten"],
  ["fix_the_grammar", "Korrigiere die Grammatik in meinem letzten Diktat."],
  ["summarize_it_briefly", "Fasse mein letztes Diktat kurz zusammen."],
])(
  "sends a localized starter for %s, not just a localized chip",
  async (label, prompt) => {
    await render(<ConversationLayout conversationId="chat" />);
    const catalog: Record<string, string> = de;
    const chip = Array.from(container.querySelectorAll('[role="button"]')).find(
      (node) => node.textContent === catalog[label],
    );
    expect(chip).toBeTruthy();
    await act(async () => (chip as HTMLElement).click());
    expect(mocks.send).toHaveBeenCalledWith("chat", prompt);
  },
);
it.each(["tool", "tool-result"] as const)(
  "uses the locale's reason wrapper for %s without altering the reason",
  async (kind) => {
    const common = {
      toolCallId: "call",
      toolName: "paste",
      reason: "User-provided reason",
    };
    const part =
      kind === "tool" ? (
        <ToolStepPart part={{ ...common, kind, status: "complete" }} />
      ) : (
        <ToolResultPart part={{ ...common, kind }} />
      );
    await render(part, { ...de, reason: "(Grund: {reason})" });
    expect(container.textContent).toContain(" (Grund: User-provided reason)");
  },
);
it("reports a failed starter without copying its private error payload to logs", async () => {
  const error = new Error("private transcript / response / credential");
  mocks.send.mockRejectedValueOnce(error);
  await render(<ConversationLayout conversationId="chat" />);
  await act(async () =>
    (container.querySelector('[role="button"]') as HTMLElement).click(),
  );
  expect(mocks.error.mock.calls).toEqual([["Failed to send message"]]);
  expect(mocks.showError).toHaveBeenCalledWith(error);
});

it("does not pull the user back down when a queued resize frame runs after scrolling up", async () => {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let resize: ResizeObserverCallback = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  await render(<ConversationLayout conversationId="chat" />);
  const viewport = container.querySelector<HTMLDivElement>(
    '[data-testid="viewport"]',
  )!;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  for (const [id, callback] of frames) {
    frames.delete(id);
    callback(0);
  }
  expect(viewport.scrollTop).toBe(1000);
  resize([], {} as ResizeObserver);
  expect(frames.size).toBe(1);
  await act(async () => {
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  for (const [id, callback] of frames) {
    frames.delete(id);
    callback(0);
  }
  expect(viewport.scrollTop).toBe(0);

  await act(async () => {
    viewport.scrollTop = 900;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  resize([], {} as ResizeObserver);
  resize([], {} as ResizeObserver);
  expect(frames.size).toBe(1);
  await render(<div />);
  expect(frames.size).toBe(0);
});

it("starts only one starter request for rapid clicks before React commits", async () => {
  let finish: () => void = () => undefined;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render(<ConversationLayout conversationId="chat" />);
  const chip = container.querySelector<HTMLElement>('[role="button"]')!;
  await act(async () => {
    chip.click();
    chip.click();
  });
  expect(mocks.send).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
});

it("resets the scroll-following indicator when changing conversations", async () => {
  setAppState(
    {
      ...structuredClone(INITIAL_APP_STATE),
      chatMessageIdsByConversationId: { chat: ["a"], next: ["b"] },
    },
    true,
  );
  await render(<ConversationLayout conversationId="chat" />);
  const viewport = container.querySelector<HTMLDivElement>(
    '[data-testid="viewport"]',
  )!;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  await act(async () => {
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  expect(container.textContent).toContain(de.back_to_latest);
  await render(<ConversationLayout conversationId="next" />);
  expect(container.textContent).not.toContain(de.back_to_latest);
});

it("does not override a user scroll before the initial follow frame", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  await render(<ConversationLayout conversationId="chat" />);
  const viewport = container.querySelector<HTMLDivElement>(
    '[data-testid="viewport"]',
  )!;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  await act(async () => {
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  for (const [id, callback] of frames) {
    frames.delete(id);
    callback(0);
  }
  expect(viewport.scrollTop).toBe(0);
});

import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: never) => unknown>(),
  hotkey: null as null | { onFire: () => void },
  state: { pillConversationId: null as string | null },
  create: vi.fn(),
  send: vi.fn(),
  load: vi.fn(),
  navigate: vi.fn(),
  surface: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("react-intl", () => ({
  useIntl: () => ({ formatMessage: () => "New conversation" }),
}));
vi.mock("../../hooks/tauri.hooks", () => ({
  useTauriListen: (name: string, callback: (payload?: never) => unknown) =>
    mocks.handlers.set(name, callback),
}));
vi.mock("../../hooks/hotkey.hooks", () => ({
  useHotkeyFire: (args: typeof mocks.hotkey) => {
    mocks.hotkey = args;
  },
}));
vi.mock("../../actions/chat.actions", () => ({
  createConversation: mocks.create,
  sendChatMessage: mocks.send,
  loadChatMessages: mocks.load,
}));
vi.mock("../../store", () => ({
  getAppState: () => mocks.state,
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../../router", () => ({
  getBrowserRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../utils/window.utils", () => ({
  surfaceMainWindow: mocks.surface,
}));
vi.mock("../../utils/keyboard.utils", () => ({
  OPEN_CHAT_HOTKEY: "open_chat",
}));
vi.mock("../../utils/id.utils", () => ({ createId: () => "generated" }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: mocks.warning,
    error: mocks.error,
  }),
}));
import { useDictationAssistant } from "./dictation-assistant.hooks";

beforeEach(() => {
  mocks.handlers.clear();
  mocks.state.pillConversationId = null;
  vi.clearAllMocks();
  mocks.send.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(undefined);
  mocks.navigate.mockResolvedValue(undefined);
  mocks.surface.mockResolvedValue(undefined);
});
it("shares creation between concurrent typed messages", async () => {
  let finish!: (result: { id: string }) => void;
  mocks.create.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  useDictationAssistant({
    isMainWindow: true,
    abortRecording: vi.fn().mockResolvedValue(undefined),
    enterTypeMode: vi.fn(),
    recordingOperationRef: { current: 1 },
  });
  const typed = mocks.handlers.get("assistant-typed-message")!;
  const first = typed({ text: "one" } as never);
  const second = typed({ text: "two" } as never);
  expect(mocks.create).toHaveBeenCalledOnce();
  finish({ id: "conversation" });
  await Promise.all([first, second]);
  expect(mocks.send).toHaveBeenCalledWith("conversation", "one");
  expect(mocks.send).toHaveBeenCalledWith("conversation", "two");
  expect(mocks.state.pillConversationId).toBe("conversation");
});
it("leaves the main-window controls inert in other webviews", async () => {
  const enterTypeMode = vi.fn();
  const abortRecording = vi.fn().mockResolvedValue(undefined);
  useDictationAssistant({
    isMainWindow: false,
    abortRecording,
    enterTypeMode,
    recordingOperationRef: { current: 1 },
  });
  mocks.handlers.get("assistant-enable-type-mode")?.();
  await mocks.handlers.get("assistant-mode-close")?.();
  await mocks.handlers.get("assistant-typed-message")?.({
    text: "hello",
  } as never);
  expect(enterTypeMode).not.toHaveBeenCalled();
  expect(abortRecording).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("does not resurrect a conversation after the recording is retired", async () => {
  let finish!: (result: { id: string }) => void;
  mocks.create.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const recordingOperationRef = { current: 1 };
  useDictationAssistant({
    isMainWindow: true,
    abortRecording: vi.fn().mockResolvedValue(undefined),
    enterTypeMode: vi.fn(),
    recordingOperationRef,
  });
  const typed = mocks.handlers.get("assistant-typed-message")!({
    text: "private",
  } as never);
  recordingOperationRef.current++;
  finish({ id: "retired" });
  await typed;
  expect(mocks.state.pillConversationId).toBeNull();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  "only aborts the recording that requested conversation navigation (replaced=%s)",
  async (replaced) => {
    let finishNavigation!: () => void;
    mocks.navigate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishNavigation = resolve;
      }),
    );
    const recordingOperationRef = { current: 1 };
    const abortRecording = vi.fn().mockResolvedValue(undefined);
    useDictationAssistant({
      isMainWindow: true,
      abortRecording,
      enterTypeMode: vi.fn(),
      recordingOperationRef,
    });
    mocks.handlers.get("open-pill-conversation")!({
      conversationId: "conversation",
    } as never);
    if (replaced) recordingOperationRef.current++;
    finishNavigation();
    await vi.waitFor(() => expect(mocks.surface).toHaveBeenCalledOnce());
    await Promise.resolve();
    if (replaced) expect(abortRecording).not.toHaveBeenCalled();
    else expect(abortRecording).toHaveBeenCalledOnce();
  },
);

it("does not abort a successor while the main window is still surfacing", async () => {
  let finishSurface!: () => void;
  mocks.surface.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSurface = resolve;
    }),
  );
  const recordingOperationRef = { current: 1 };
  const abortRecording = vi.fn().mockResolvedValue(undefined);
  useDictationAssistant({
    isMainWindow: true,
    abortRecording,
    enterTypeMode: vi.fn(),
    recordingOperationRef,
  });
  mocks.hotkey!.onFire();
  await vi.waitFor(() => expect(mocks.surface).toHaveBeenCalledOnce());
  recordingOperationRef.current++;
  finishSurface();
  await Promise.resolve();
  await Promise.resolve();
  expect(abortRecording).not.toHaveBeenCalled();
});

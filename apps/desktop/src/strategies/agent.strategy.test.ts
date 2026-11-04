import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  produce: vi.fn(),
}));
vi.mock("../actions/chat.actions", () => ({
  createConversation: mocks.createConversation,
  sendChatMessage: vi.fn(),
}));
vi.mock("../store", () => ({
  getAppState: vi.fn(),
  produceAppState: mocks.produce,
}));
vi.mock("../i18n", () => ({
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn() }),
}));
import { AgentStrategy } from "./agent.strategy";

it("does not restore a conversation after its recording was aborted during creation", async () => {
  let finish!: (value: { id: string }) => void;
  mocks.createConversation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const strategy = new AgentStrategy();
  const starting = strategy.onBeforeStart();
  await strategy.cleanup();
  mocks.produce.mockClear();
  finish({ id: "created-before-clear" });
  await starting;
  expect(mocks.produce).not.toHaveBeenCalled();
});

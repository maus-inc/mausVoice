import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  close: vi.fn(async (_rid: number): Promise<void> => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage?: unknown;
  },
  Resource: class {
    constructor(readonly rid: number) {}
    close() {
      return mocks.close(this.rid);
    }
  },
}));
import {
  checkForUpdate,
  closeAvailableUpdate,
  hasAvailableUpdate,
  installAvailableUpdate,
} from "../../../../packages/desktop-utils/src/updater";
afterEach(async () => {
  await closeAvailableUpdate();
  vi.clearAllMocks();
});
it("detaches the old resource before awaiting close so it cannot erase a newer offer", async () => {
  const metadata = (rid: number) => ({
    rid,
    currentVersion: "0.1.6",
    version: "0.1.7",
    rawJson: {},
  });
  mocks.invoke.mockResolvedValueOnce(metadata(1));
  await checkForUpdate("linux");
  let finish!: () => void;
  mocks.close.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const closing = closeAvailableUpdate();
  const visibleWhileClosing = hasAvailableUpdate();
  mocks.invoke.mockResolvedValueOnce(metadata(2));
  await checkForUpdate("linux");
  finish();
  await closing;
  expect(visibleWhileClosing).toBe(false);
  expect(hasAvailableUpdate()).toBe(true);
  expect(mocks.close.mock.calls).toEqual([[1]]);
  await installAvailableUpdate();
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "plugin:updater|download_and_install",
    { rid: 2, onEvent: expect.anything() },
  );
});

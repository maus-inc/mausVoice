// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";

const run = vi.hoisted(() => vi.fn());
vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: { runNativeSetup: run },
}));
import {
  runInputPermissionSetup,
  useInputPermissionSetupRunning,
} from "./input-permission-setup";

ensureUiHarness();

it("keeps one native prompt across a page unmount and remount, then permits retry", async () => {
  let finish!: (result: string) => void;
  run.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Probe = () =>
    createElement("output", null, String(useInputPermissionSetupRunning()));
  act(() => root.render(createElement(Probe)));
  let first!: ReturnType<typeof runInputPermissionSetup>;
  act(() => {
    first = runInputPermissionSetup();
  });
  expect(container.textContent).toBe("true");
  act(() => root.render(null));
  act(() => root.render(createElement(Probe)));
  expect(container.textContent).toBe("true");
  await expect(runInputPermissionSetup()).resolves.toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish("success");
    await first;
  });
  expect(container.textContent).toBe("false");
  run.mockResolvedValueOnce("cancelled");
  await act(async () => {
    await expect(runInputPermissionSetup()).resolves.toBe("cancelled");
  });
  expect(run).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  container.remove();
});

it("unlocks after a native setup failure", async () => {
  run
    .mockReset()
    .mockRejectedValueOnce(new Error("failure"))
    .mockResolvedValueOnce("success");
  await expect(runInputPermissionSetup()).rejects.toThrow("failure");
  await expect(runInputPermissionSetup()).resolves.toBe("success");
  expect(run).toHaveBeenCalledTimes(2);
});

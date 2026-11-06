// @vitest-environment jsdom
import type { RemoteReceiverStatus } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const actions = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  save: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  refresh: vi.fn(),
  pair: vi.fn(),
  selectTarget: vi.fn(),
  enableOutput: vi.fn(),
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../../actions/app.actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/app.actions")>()),
  showErrorSnackbar: actions.error,
  showSnackbar: actions.message,
}));
vi.mock("../../actions/user.actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/user.actions")>()),
  setRemoteReceiverPort: actions.save,
  setRemoteTargetDeviceId: actions.selectTarget,
  setRemoteOutputEnabled: actions.enableOutput,
}));
vi.mock("../../actions/remote-pairing.actions", () => ({
  buildRemotePairingInvite: vi.fn(),
  pairWithRemoteInvite: actions.pair,
}));
vi.mock("../../actions/remote-receiver.actions", () => ({
  startRemoteReceiver: actions.start,
  stopRemoteReceiver: actions.stop,
  refreshRemoteReceiverStatus: actions.refresh,
}));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { MultiDeviceDialog } from "./MultiDeviceDialog";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const receiver: RemoteReceiverStatus = {
  enabled: true,
  deviceId: "receiver",
  deviceName: "Receiver",
  devicePlatform: "windows",
  listenAddress: "127.0.0.1",
  port: 1234,
  pairingCode: "code",
  lastSenderDeviceId: null,
  lastEventId: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  lastError: null,
  lastTargetClassName: null,
  lastTargetTitle: null,
  lastTargetEditable: null,
};

beforeEach(async () => {
  vi.resetAllMocks();
  actions.refresh.mockResolvedValue(receiver);
  actions.save.mockResolvedValue(undefined);
  actions.selectTarget.mockResolvedValue(undefined);
  actions.enableOutput.mockResolvedValue(undefined);
  actions.stop.mockResolvedValue(receiver);
  actions.start.mockResolvedValue(receiver);
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.multiDeviceDialogOpen = true;
  state.remoteReceiverStatus = receiver;
  setAppState(state, true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(MultiDeviceDialog));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const applyPort = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Auto"]',
  );
  if (!input) throw new Error("Receiver port field not found");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "Apply",
  );
  if (!button) throw new Error("Apply button not found");
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

it("rejects out-of-range ports before saving or stopping the receiver", async () => {
  await applyPort("65536");
  expect(actions.error).toHaveBeenCalledWith(
    "Receiver port must be an integer from 1 to 65535.",
  );
  expect(actions.save).not.toHaveBeenCalled();
  expect(actions.stop).not.toHaveBeenCalled();
  expect(actions.start).not.toHaveBeenCalled();
});

it("saves and restarts the receiver at the highest valid port", async () => {
  const order: string[] = [];
  actions.save.mockImplementation(async () => {
    order.push("save");
  });
  actions.stop.mockImplementation(async () => {
    order.push("stop");
  });
  actions.start.mockImplementation(async () => {
    order.push("start");
  });
  await applyPort("65535");
  expect(actions.save).toHaveBeenCalledWith(65535);
  expect(actions.start).toHaveBeenCalledWith(65535);
  expect(order).toEqual(["save", "stop", "start"]);
  expect(actions.message).toHaveBeenCalledWith(
    "Receiver port updated and receiver restarted.",
    { mode: "success" },
  );
});

it("does not stop the receiver when saving the port fails", async () => {
  const error = new Error("Preference save failed");
  actions.save.mockRejectedValue(error);
  await applyPort("4444");
  expect(actions.error).toHaveBeenCalledWith(error);
  expect(actions.stop).not.toHaveBeenCalled();
  expect(actions.start).not.toHaveBeenCalled();
});

it("offers import without a local receiver and prevents duplicate in-flight pairings", async () => {
  await act(async () =>
    setAppState({ remoteReceiverStatus: { ...receiver, enabled: false } }),
  );
  const findButton = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  expect(findButton("Copy invite")?.disabled).toBe(true);
  expect(findButton("Import invite")?.disabled).toBe(false);
  await act(async () => findButton("Import invite")?.click());
  const input = document.querySelector<HTMLTextAreaElement>("textarea");
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "invite-code");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let finish!: (value: { name: string }) => void;
  actions.pair.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pair = findButton("Pair");
  expect(pair?.disabled).toBe(false);
  await act(async () => {
    pair?.click();
    pair?.click();
  });
  expect(actions.pair).toHaveBeenCalledTimes(1);
  expect(actions.pair).toHaveBeenCalledWith("invite-code");
  expect(findButton("Cancel")?.disabled).toBe(true);
  expect(input?.disabled).toBe(true);
  await act(async () => finish({ name: "Receiver" }));
  expect(actions.message).toHaveBeenCalledWith("Paired with Receiver.", {
    mode: "success",
  });
});

it("keeps a failed invite available to retry", async () => {
  const findButton = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  await act(async () => findButton("Import invite")?.click());
  const input = document.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "invite-code");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const error = new Error("pairing failed");
  actions.pair.mockRejectedValueOnce(error);
  await act(async () => findButton("Pair")?.click());
  expect(actions.error).toHaveBeenCalledWith(error);
  expect(input?.value).toBe("invite-code");
  expect(input?.disabled).toBe(false);
  expect(findButton("Pair")?.disabled).toBe(false);
  actions.pair.mockResolvedValueOnce({ name: "Receiver" });
  await act(async () => findButton("Pair")?.click());
  expect(actions.pair).toHaveBeenCalledTimes(2);
  expect(actions.message).toHaveBeenCalledWith("Paired with Receiver.", {
    mode: "success",
  });
});

it("does not show a pairing notification after the dialog component unmounts", async () => {
  const findButton = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  await act(async () => findButton("Import invite")?.click());
  const input = document.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, "invite-code");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let finish!: (value: { name: string }) => void;
  actions.pair.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => findButton("Pair")?.click());
  act(() => root.render(null));
  await act(async () => finish({ name: "Receiver" }));
  expect(actions.message).not.toHaveBeenCalled();
});

it("serializes a double apply while the receiver port save is pending", async () => {
  let finish!: () => void;
  actions.save.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Auto"]',
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "4444");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const apply = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Apply",
  );
  await act(async () => {
    apply?.click();
    apply?.click();
  });
  expect(actions.save).toHaveBeenCalledTimes(1);
  expect(input?.disabled).toBe(true);
  await act(async () => finish());
  expect(actions.stop).toHaveBeenCalledTimes(1);
  expect(actions.start).toHaveBeenCalledTimes(1);
});

it("does not apply a port while a receiver toggle is in flight", async () => {
  let finish!: () => void;
  actions.stop.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Auto"]',
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "4444");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const receiverSwitch = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  const apply = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Apply",
  );
  expect(receiverSwitch?.checked).toBe(true);
  await act(async () => {
    receiverSwitch?.click();
    apply?.click();
  });
  expect(actions.stop).toHaveBeenCalledTimes(1);
  expect(actions.save).not.toHaveBeenCalled();
  await act(async () => finish());
});

it.each(["receiver", "both"] as const)(
  "selects a %s target without a stale second enable",
  async (role) => {
    await act(async () =>
      setAppState({
        pairedRemoteDeviceById: {
          target: {
            id: "target",
            name: "Target",
            platform: "windows",
            role,
            sharedSecret: "secret",
            pairedAt: "2026-01-01",
            lastSeenAt: null,
            lastKnownAddress: "127.0.0.1:1234",
            trusted: true,
          },
        },
      }),
    );
    expect(document.body.textContent).toContain(
      "Route finalized dictation to a paired desktop instead of inserting locally.",
    );
    let finish!: () => void;
    actions.selectTarget.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const title = [...document.querySelectorAll("p")].find(
      (item) => item.textContent === "Send transcript to another device",
    );
    const toggle =
      title?.parentElement?.parentElement?.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
    expect(toggle).toBeDefined();
    await act(async () => toggle?.click());
    expect(actions.selectTarget).toHaveBeenCalledWith("target");
    await act(async () => finish());
    expect(actions.enableOutput).not.toHaveBeenCalled();
  },
);

it("allows a manual device to act as both sender and receiver", async () => {
  const add = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Add device",
  );
  expect(add).toBeDefined();
  await act(async () => add?.click());
  const role = document.querySelector<HTMLElement>(
    '[aria-label="Device role"]',
  );
  expect(role).not.toBeNull();
  await act(async () =>
    role?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );
  const both = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent === "Sender device / Receiver device");
  expect(both).toBeDefined();
  await act(async () => both?.click());
  expect(role?.textContent).toContain("Sender device / Receiver device");
  expect(document.body.textContent).toContain("Receiver address");
});

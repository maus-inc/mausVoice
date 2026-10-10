import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

import {
  decodeToastActionToken,
  encodeToastActionToken,
} from "../types/toast.types";

const { dismissToast, showPersistentToast, showToast } =
  await import("./toast.actions");

const payloadTypes = () =>
  invoke.mock.calls.map(
    (call) => JSON.parse((call[1] as { payload: string }).payload).type,
  );

// `resolve` takes an optional value so a `deferred<undefined>()` signal can be
// released with a bare `resolve()`, the way a bare `resolve()` reads at the
// call site.
const deferred = <T>() => {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      resolvePromise(value as T);
    };
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("native toast IPC ordering", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("delivers a slow show before a later dismiss", async () => {
    const delivered: string[] = [];
    // These two signals carry no payload, so they are typed `undefined` rather
    // than `void`: `deferred<void>()` reads as a bare generic `void`, which is
    // the shape JS-0333 rejects.
    const showArrived = deferred<undefined>();
    const releaseShow = deferred<undefined>();
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { type } = JSON.parse((args as { payload: string }).payload);
      if (type === "toast") {
        showArrived.resolve();
        await releaseShow.promise;
      }
      delivered.push(type);
    });

    const showing = showPersistentToast("working", 120_000);
    const dismissing = dismissToast();
    await showArrived.promise;
    releaseShow.resolve();
    await Promise.all([showing, dismissing]);

    // Without serialization the dismiss lands first and the loading toast
    // stays on screen for its full duration.
    expect(delivered).toEqual(["toast", "dismiss_toast"]);
  });

  it("keeps serving later toasts after one fails", async () => {
    invoke
      .mockRejectedValueOnce(new Error("pill offline"))
      .mockResolvedValueOnce(undefined);

    await expect(showPersistentToast("first", 1000)).rejects.toThrow(
      "pill offline",
    );
    await expect(dismissToast()).resolves.toBeUndefined();
    expect(payloadTypes()).toEqual(["toast", "dismiss_toast"]);
  });
});

describe("queue isolation across sequential callers", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("does not replay or drop commands after an earlier rejection", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(dismissToast()).rejects.toThrow("boom");

    invoke.mockResolvedValue(undefined);
    await showPersistentToast("a", 1000);
    await dismissToast();
    await showPersistentToast("b", 1000);

    expect(payloadTypes()).toEqual([
      "dismiss_toast",
      "toast",
      "dismiss_toast",
      "toast",
    ]);
  });
});

describe("toast action proposal correlation", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  const payloadOf = (call: number) =>
    JSON.parse((invoke.mock.calls[call][1] as { payload: string }).payload);

  it("carries the proposal id on both actions and labels the buttons from the bare action", async () => {
    await showToast({
      message: 'Add "Soniya" to your dictionary?',
      action: "auto_learn_accept",
      rejectAction: "auto_learn_reject",
      proposalId: "7",
    });

    const payload = payloadOf(0);
    // The pill echoes the action token verbatim and renders `action_label`
    // separately, so the id rides in the token and the label stays the plain
    // word the user reads.
    expect(payload.action).toBe("auto_learn_accept#7");
    expect(payload.action_label).toBe("Add");
    expect(payload.reject_action).toBe("auto_learn_reject#7");
    expect(payload.reject_action_label).toBe("Ignore");
  });

  it("leaves an action with no proposal id exactly as it was", async () => {
    await showToast({ message: "Upgrading", action: "upgrade" });

    const payload = payloadOf(0);
    expect(payload.action).toBe("upgrade");
    expect(payload.action_label).toBe("Upgrade");
  });

  it("reads a clicked token back into the action and the proposal it named", () => {
    expect(decodeToastActionToken("auto_learn_accept#7")).toEqual({
      action: "auto_learn_accept",
      proposalId: "7",
    });
  });

  it.each([
    ["upgrade", { action: "upgrade" }],
    [
      "confirm_cancel_transcription",
      { action: "confirm_cancel_transcription" },
    ],
  ])("round-trips %s through the token without an id", (action, expected) => {
    const token = encodeToastActionToken(
      action as Parameters<typeof encodeToastActionToken>[0],
    );
    expect(token).toBe(action);
    expect(decodeToastActionToken(token)).toEqual(expected);
  });

  it("does not mistake a token for an action it does not know", () => {
    // A pill that predates the id, or a token this app never sent, must not be
    // read as one of our actions: it is passed through whole, so it matches no
    // action and the click is discarded rather than attributed to a proposal.
    expect(decodeToastActionToken("some_future_action#7")).toEqual({
      action: "some_future_action#7",
    });
  });

  it("does not split a token whose id contains the separator", () => {
    // Ids are minted as decimal counters, so this token cannot be one of ours.
    // Splitting at the last separator would name a half-action, so the token is
    // passed through whole and matches nothing.
    expect(decodeToastActionToken("auto_learn_accept#a#b")).toEqual({
      action: "auto_learn_accept#a#b",
    });
  });
});

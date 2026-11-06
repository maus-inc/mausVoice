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

const {
  dismissMicrophoneSafetyToast,
  dismissToast,
  dismissToastForAction,
  runToast,
  showPersistentToast,
  showToast,
} = await import("./toast.actions");

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

  it("swallows a toast rejection even if the diagnostic sink throws", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("diagnostic unavailable");
    });
    try {
      runToast(Promise.reject(new Error("toast unavailable")));
      await Promise.resolve();
      expect(logger).toHaveBeenCalledOnce();
    } finally {
      logger.mockRestore();
    }
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

  it("drops a queued toast whose owner retires before dispatch", async () => {
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    invoke.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    invoke.mockResolvedValue(undefined);
    const first = showToast({ message: "first" });
    await entered.promise;
    let current = true;
    const stale = showToast({ message: "old", isCurrent: () => current });
    current = false;
    const next = showToast({ message: "next" });
    release.resolve();
    await Promise.all([first, stale, next]);
    expect(invoke).toHaveBeenCalledTimes(2);
    const messages = invoke.mock.calls.map(
      (call) => JSON.parse((call[1] as { payload: string }).payload).message,
    );
    expect(messages).toEqual(["first", "next"]);
  });

  it("sends the scoped dismissal after its queued toast with the exact action token", async () => {
    const entered = deferred<undefined>();
    const release = deferred<undefined>();
    invoke.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    invoke.mockResolvedValue(undefined);
    const showing = showToast({
      message: "Finalizing audio",
      action: "cancel_recording_stop",
      proposalId: "owner-1",
    });
    await entered.promise;
    const dismissing = dismissToastForAction(
      "cancel_recording_stop",
      "owner-1",
    );
    release.resolve();
    await Promise.all([showing, dismissing]);
    const payloads = invoke.mock.calls.map((call) =>
      JSON.parse((call[1] as { payload: string }).payload),
    );
    expect(payloads[0].action).toBe("cancel_recording_stop#owner-1");
    expect(payloads[1]).toEqual({
      type: "dismiss_toast",
      expected_action: "cancel_recording_stop#owner-1",
    });
  });

  it("scopes microphone warning dismissal to its owner", async () => {
    await showToast({
      message: "Microphone may still be in use",
      microphoneSafetyOwner: "owner-1",
    });
    await dismissMicrophoneSafetyToast("owner-1");
    const payloads = invoke.mock.calls.map((call) =>
      JSON.parse((call[1] as { payload: string }).payload),
    );
    expect(payloads[0].microphone_safety_owner).toBe("owner-1");
    expect(payloads[1]).toEqual({
      type: "dismiss_toast",
      expected_safety_owner: "owner-1",
    });
  });

  it("rejects missing scope instead of sending an unscoped dismissal", async () => {
    await expect(dismissMicrophoneSafetyToast("")).rejects.toThrow();
    await expect(
      dismissToastForAction("cancel_recording_stop", ""),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
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

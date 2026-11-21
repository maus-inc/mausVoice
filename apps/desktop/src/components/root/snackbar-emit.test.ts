import { afterEach, describe, expect, it, vi } from "vitest";

const toast = Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
});

vi.mock("sonner", () => ({ toast }));

describe("emitSnackbarIfNew", () => {
  afterEach(async () => {
    toast.mockClear();
    toast.error.mockClear();
    toast.success.mockClear();
    const { resetSnackbarEmitForTests } = await import("./snackbar-emit");
    resetSnackbarEmitForTests();
  });

  it("emits once for a counter and ignores remount replay", async () => {
    const { emitSnackbarIfNew } = await import("./snackbar-emit");
    const payload = {
      snackbarCounter: 3,
      snackbarMessage: "Delete successful",
      snackbarDuration: 5000,
      snackbarMode: "success" as const,
    };
    expect(emitSnackbarIfNew(payload)).toBe(true);
    expect(emitSnackbarIfNew(payload)).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  // The emitter walks the whole queue on every counter change, so it asks about
  // counters it has already shown. Comparing with `===` answered "not equal,
  // therefore new" for every one of them below the high-water mark, which
  // re-toasted the entire queue each time a message was added. A dismissed
  // toast came back on the next snackbar, and a burst of N messages produced
  // roughly N^2 toasts.
  it("does not re-emit a counter below the last one it showed", async () => {
    const { emitSnackbarIfNew } = await import("./snackbar-emit");

    // The queue as the real emitter sees it: it still holds 1 and 2 when 3
    // arrives, and the loop asks about all three in order.
    expect(
      emitSnackbarIfNew({ snackbarCounter: 1, snackbarMessage: "first" }),
    ).toBe(true);
    expect(
      emitSnackbarIfNew({ snackbarCounter: 2, snackbarMessage: "second" }),
    ).toBe(true);

    toast.mockClear();
    toast.success.mockClear();

    expect(
      emitSnackbarIfNew({ snackbarCounter: 3, snackbarMessage: "third" }),
    ).toBe(true);
    // The replayed queue entries. Both are already on screen.
    expect(
      emitSnackbarIfNew({ snackbarCounter: 1, snackbarMessage: "first" }),
    ).toBe(false);
    expect(
      emitSnackbarIfNew({ snackbarCounter: 2, snackbarMessage: "second" }),
    ).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith("third", expect.anything());
  });

  it("still emits one that arrives out of order after the high-water mark", async () => {
    // The other half of the guard: `<=` must not become "only ever go up", or a
    // counter that legitimately jumps would be dropped.
    const { emitSnackbarIfNew } = await import("./snackbar-emit");
    expect(
      emitSnackbarIfNew({ snackbarCounter: 7, snackbarMessage: "seventh" }),
    ).toBe(true);
    expect(
      emitSnackbarIfNew({ snackbarCounter: 9, snackbarMessage: "ninth" }),
    ).toBe(true);
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

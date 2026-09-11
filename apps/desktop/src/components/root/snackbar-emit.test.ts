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
});

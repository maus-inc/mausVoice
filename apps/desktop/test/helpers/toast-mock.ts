/**
 * Shared stub for `runToast` from `src/actions/toast.actions`.
 *
 * `runToast` fires a toast without awaiting it and swallows the rejection, so
 * a mocked `toast.actions` module must still provide a working implementation.
 * Omitting it makes vitest fail with "No runToast export is defined on the
 * mock", and returning a no-op would let an unhandled rejection escape.
 * Loaded from inside the vi.mock factory, since the factory runs before static
 * imports resolve.
 *
 * Usage:
 *
 *   vi.mock("./toast.actions", async () => {
 *     const { runToastMock } = await import("../../test/helpers/toast-mock");
 *     return { showToast: vi.fn(), runToast: runToastMock };
 *   });
 */
export const runToastMock = (work: Promise<void>): void => {
  void work.catch(() => undefined);
};

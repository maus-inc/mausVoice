import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import {
  LocalUserPreferencesRepo,
  toLocalPreferences,
} from "./preferences.repo";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("expansion flag compare-and-set repository", () => {
  it("passes the expected snapshot and returns the saved preferences", async () => {
    const flags = '{"localApiEnabled":true}';
    vi.mocked(invoke).mockResolvedValue({
      ...toLocalPreferences(createDefaultPreferences()),
      expansionFlags: flags,
    });
    const saved =
      await new LocalUserPreferencesRepo().compareAndSetExpansionFlags(
        "{}",
        flags,
      );
    expect(invoke).toHaveBeenCalledWith(
      "user_preferences_compare_set_expansion_flags",
      {
        args: { expected: "{}", flags },
      },
    );
    expect(saved?.expansionFlags).toBe(flags);
  });

  it("keeps a native conflict distinct from a saved row", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(
      new LocalUserPreferencesRepo().compareAndSetExpansionFlags("{}", "{}"),
    ).resolves.toBeNull();
  });

  it("propagates native failures rather than retrying them as conflicts", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("database unavailable"));
    await expect(
      new LocalUserPreferencesRepo().compareAndSetExpansionFlags("{}", "{}"),
    ).rejects.toThrow("database unavailable");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { getAppState } from "../store";
import {
  applyPreviewScenario,
  getActivePreviewScenario,
  invokePreviewCommand,
  PreviewOperationError,
} from "./runtime";

describe("browser preview transport", () => {
  beforeEach(() => {
    applyPreviewScenario("populated");
  });

  it("retains the selected scenario when a route omits its query parameter", () => {
    applyPreviewScenario("empty");

    expect(getActivePreviewScenario()).toBe("empty");
  });

  it("compares flag snapshots and preserves flags across stale full-row saves", async () => {
    const old = await invokePreviewCommand<Record<string, unknown>>(
      "user_preferences_get",
    );
    const first = '{"localApiEnabled":true}';
    const saved = await invokePreviewCommand<Record<string, unknown>>(
      "user_preferences_compare_set_expansion_flags",
      { args: { expected: old.expansionFlags ?? "{}", flags: first } },
    );
    expect(saved.expansionFlags).toBe(first);
    await expect(
      invokePreviewCommand("user_preferences_compare_set_expansion_flags", {
        args: {
          expected: old.expansionFlags ?? "{}",
          flags: '{"meetingNotesEnabled":true}',
        },
      }),
    ).resolves.toBeNull();
    const updated = await invokePreviewCommand<Record<string, unknown>>(
      "user_preferences_set",
      {
        preferences: { ...old, ignoreUpdateDialog: true },
      },
    );
    expect(updated.expansionFlags).toBe(first);
    expect(updated.ignoreUpdateDialog).toBe(true);
    await expect(
      invokePreviewCommand("user_preferences_set_expansion_flags", {
        args: { flags: "{}" },
      }),
    ).resolves.toMatchObject({ expansionFlags: "{}" });
  });

  it("returns independent local records for repository-backed pages", async () => {
    const first = await invokePreviewCommand<Record<string, unknown>[]>(
      "transcription_list",
      { limit: 20, offset: 0 },
    );
    first[0].transcript = "Changed outside the mock database";

    const second = await invokePreviewCommand<Record<string, unknown>[]>(
      "transcription_list",
      { limit: 20, offset: 0 },
    );

    expect(second).toHaveLength(3);
    expect(second[0].transcript).not.toBe("Changed outside the mock database");
    expect(getAppState().transcriptions.transcriptionIds).toHaveLength(3);
  });

  it("persists supported dictionary mutations until the scenario is reset", async () => {
    await invokePreviewCommand("term_create", {
      term: {
        id: "term-preview-new",
        createdAt: Date.now(),
        createdByUserId: "local-user-id",
        sourceValue: "MVP",
        destinationValue: "minimum viable product",
        isReplacement: true,
        isDeleted: false,
      },
    });

    expect(
      await invokePreviewCommand<Record<string, unknown>[]>("term_list"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "term-preview-new" }),
      ]),
    );

    applyPreviewScenario("populated");
    expect(
      await invokePreviewCommand<Record<string, unknown>[]>("term_list"),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "term-preview-new" }),
      ]),
    );
  });

  it("never retains a key pasted into the mock API-key form", async () => {
    await invokePreviewCommand("api_key_create", {
      apiKey: {
        id: "preview-user-key",
        name: "Temporary key",
        provider: "openai",
        key: `${"sk"}-this-value-must-not-be-retained`,
      },
    });

    const keys =
      await invokePreviewCommand<Record<string, unknown>[]>("api_key_list");
    const saved = keys.find((key) => key.id === "preview-user-key");

    expect(saved?.keyFull).toBeNull();
    expect(saved?.keySuffix).toBe("…preview");
    expect(JSON.stringify(saved)).not.toContain(
      `${"sk"}-this-value-must-not-be-retained`,
    );
  });

  it.each([
    { prefix: {}, hotkeys: [] },
    { prefix: "", hotkeys: [] },
    { prefix: "style-", hotkeys: {} },
    { prefix: "style-", hotkeys: [null] },
    { prefix: "style-", hotkeys: [{ id: "bad", callback: () => undefined }] },
  ])(
    "preserves saved shortcuts when replacement fails for %j",
    async (args) => {
      const before = await invokePreviewCommand("hotkey_list");
      await expect(
        invokePreviewCommand("hotkey_replace_style_hotkeys", args),
      ).rejects.toThrow();
      expect(await invokePreviewCommand("hotkey_list")).toEqual(before);
    },
  );

  it("replaces only matching hotkeys and returns independent records", async () => {
    const hotkey = {
      id: "style-note",
      actionName: "style-note",
      keys: ["Alt", "N"],
    };
    const result = await invokePreviewCommand<(typeof hotkey)[]>(
      "hotkey_replace_style_hotkeys",
      {
        prefix: "style-",
        hotkeys: [hotkey],
      },
    );
    result[0].keys.push("Control");
    const saved = await invokePreviewCommand<(typeof hotkey)[]>("hotkey_list");
    expect(saved.map(({ id }) => id)).toEqual([
      "dictate",
      "agent",
      "style-note",
    ]);
    expect(saved.find(({ id }) => id === "style-note")).toEqual(hotkey);
  });

  it("routes remote commands independently of history and system commands", async () => {
    expect(await invokePreviewCommand("remote_receiver_start")).toMatchObject({
      enabled: true,
    });
    expect(await invokePreviewCommand("remote_receiver_status")).toMatchObject({
      enabled: true,
    });
    expect(await invokePreviewCommand("remote_receiver_stop")).toMatchObject({
      enabled: false,
    });
    expect(await invokePreviewCommand("get_version")).toBe("0.1.6-preview");
  });

  it("does not silently emulate unsupported privileged operations", async () => {
    await expect(invokePreviewCommand("simulate_type")).rejects.toMatchObject({
      name: "PreviewOperationError",
      command: "simulate_type",
    } satisfies Partial<PreviewOperationError>);
  });
});

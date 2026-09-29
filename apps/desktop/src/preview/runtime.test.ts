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

  it("keeps a stored openRouterConfig when an update omits it, as the desktop NULL guard does", async () => {
    await invokePreviewCommand("api_key_create", {
      apiKey: {
        id: "preview-openrouter-key",
        name: "OpenRouter",
        provider: "openrouter",
        key: `${"sk"}-preview`,
      },
    });
    const stored = JSON.stringify({
      favoriteModels: ["anthropic/claude-sonnet-4"],
    });
    await invokePreviewCommand("api_key_update", {
      request: { id: "preview-openrouter-key", openRouterConfig: stored },
    });

    // The desktop writes `openrouter_config = CASE WHEN ?9 IS NOT NULL THEN
    // ?9 ELSE openrouter_config END`, so an update that does not carry the
    // config has to leave it alone instead of clearing it. The repo always
    // sends the key, with an undefined value when the caller omitted it, so
    // that is the shape that has to survive.
    await invokePreviewCommand("api_key_update", {
      request: {
        id: "preview-openrouter-key",
        name: "Renamed",
        openRouterConfig: undefined,
      },
    });

    const keys =
      await invokePreviewCommand<Record<string, unknown>[]>("api_key_list");
    const saved = keys.find((key) => key.id === "preview-openrouter-key");
    expect(saved?.name).toBe("Renamed");
    expect(saved?.openRouterConfig).toBe(stored);
  });

  it("applies an explicit openRouterConfig on update", async () => {
    await invokePreviewCommand("api_key_create", {
      apiKey: {
        id: "preview-openrouter-key",
        name: "OpenRouter",
        provider: "openrouter",
        key: `${"sk"}-preview`,
      },
    });
    const first = JSON.stringify({
      favoriteModels: ["anthropic/claude-sonnet-4"],
    });
    await invokePreviewCommand("api_key_update", {
      request: { id: "preview-openrouter-key", openRouterConfig: first },
    });
    const second = JSON.stringify({ providerRouting: { order: ["together"] } });

    const updated = await invokePreviewCommand<Record<string, unknown>>(
      "api_key_update",
      { request: { id: "preview-openrouter-key", openRouterConfig: second } },
    );

    expect(updated.openRouterConfig).toBe(second);
    const keys =
      await invokePreviewCommand<Record<string, unknown>[]>("api_key_list");
    expect(
      keys.find((key) => key.id === "preview-openrouter-key")?.openRouterConfig,
    ).toBe(second);
  });

  it("mirrors the desktop transcription_path trim, clear and omit clauses", async () => {
    const seed = async (id: string, transcriptionPath: string) => {
      await invokePreviewCommand("api_key_create", {
        apiKey: {
          id,
          name: "Whisper",
          provider: "openai",
          key: `${"sk"}-preview`,
          transcriptionPath,
        },
      });
    };
    const update = (id: string, request: Record<string, unknown>) =>
      invokePreviewCommand<Record<string, unknown>>("api_key_update", {
        request: { id, ...request },
      });

    // A field the user emptied still sends whitespace, and `update_api_key`
    // trims before it decides: an empty result clears the column.
    await seed("preview-trim", "/stored/v1");
    expect(
      (await update("preview-trim", { transcriptionPath: " \t\n " }))
        .transcriptionPath,
    ).toBeNull();

    // A path with padding is stored trimmed, not as typed.
    await seed("preview-padded", "/stored/v1");
    const padded = await update("preview-padded", {
      transcriptionPath: "  /whisper/v1/audio/transcriptions  ",
    });
    expect(padded.transcriptionPath).toBe("/whisper/v1/audio/transcriptions");

    // An explicit clear wins over a path sent in the same request.
    await seed("preview-clear", "/stored/v1");
    expect(
      (
        await update("preview-clear", {
          transcriptionPath: "/ignored/v1",
          clearTranscriptionPath: true,
        })
      ).transcriptionPath,
    ).toBeNull();

    // A request that never mentions the column leaves it alone, and so does a
    // null with no clear flag: the desktop deserialises both to None, and only
    // `clear_transcription_path` reaching the statement clears the column.
    await seed("preview-omitted", "/stored/v1");
    const omitted = await update("preview-omitted", { name: "Renamed" });
    expect(omitted.name).toBe("Renamed");
    expect(omitted.transcriptionPath).toBe("/stored/v1");
    expect(
      (await update("preview-omitted", { transcriptionPath: null }))
        .transcriptionPath,
    ).toBe("/stored/v1");
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

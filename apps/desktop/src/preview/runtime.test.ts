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

  // The settings page drives stop_key_listener, stop_recording and
  // clear_local_data, then reloads. Without a handler the wipe rejected and the
  // dialog reported an error, so "Clear local data" could not be exercised in
  // the preview at all.
  it("empties the mock database when local data is cleared", async () => {
    await invokePreviewCommand("clear_local_data");

    expect(await invokePreviewCommand("term_list")).toEqual([]);
    expect(await invokePreviewCommand("user_get_one")).toBeNull();
    expect(
      await invokePreviewCommand<Record<string, unknown>[]>(
        "transcription_list",
        { limit: 20, offset: 0 },
      ),
    ).toEqual([]);
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

  it("echoes back the pairing payload the real command receives", async () => {
    // `paired-remote-device.repo.ts` sends the device fields as the command's
    // `args` payload, and `paired_remote_device_upsert` binds that same name.
    // The preview read `args.device`, so it always produced undefined and the
    // pairing page in the browser preview could not show the device it had just
    // saved.
    const device = {
      id: "device-7",
      name: "Studio",
      platform: "darwin",
      role: "receiver",
      sharedSecret: "secret",
      pairedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
      lastKnownAddress: "192.168.1.25:43123",
      trusted: true,
    };

    const echoed = await invokePreviewCommand<
      Record<string, unknown> | undefined
    >("paired_remote_device_upsert", { args: device });

    expect(echoed).toMatchObject({ id: "device-7", name: "Studio" });
  });

  it("does not silently emulate unsupported privileged operations", async () => {
    await expect(invokePreviewCommand("simulate_type")).rejects.toMatchObject({
      name: "PreviewOperationError",
      command: "simulate_type",
    } satisfies Partial<PreviewOperationError>);
  });

  it("acknowledges every accepted no-op system command with undefined", async () => {
    // Listed by name rather than read off the module, because the point is to
    // pin the set: drop any one of these from SYSTEM_NO_OP_COMMANDS and its
    // `undefined` answer turns into a PreviewOperationError, which fails here.
    const accepted = [
      "notify_pill_style_info",
      "open_app_settings",
      "pause_recording",
      "quit_app",
      "remote_sender_disconnect",
      "reset_key_listener_state",
      "reset_native_setup",
      "restart_app",
      "restart_key_listener",
      "resume_recording",
      "retry_key_listener",
      "set_auto_launch",
      "set_dashboard_menu_labels",
      "set_interaction_chime_enabled",
      "set_interaction_feedback_volume",
      "set_menu_icon",
      "set_phase",
      "set_pill_placement",
      "set_pill_visibility",
      "set_pill_visibility_menu_state",
      "set_pill_window_size",
      "set_register_app_label",
      "set_reset_pill_position_enabled",
      "set_tray_language_menu",
      "set_tray_title",
      "set_tray_visible",
      "show_in_folder",
      "show_notification",
      "start_key_listener",
      "stop_key_listener",
      "sync_compositor_hotkeys",
      "sync_hotkey_combos",
    ];

    for (const command of accepted) {
      await expect(
        invokePreviewCommand(command),
        command,
      ).resolves.toBeUndefined();
    }
  });

  it("still refuses an unknown system command, so the no-op list is not a catch-all", async () => {
    // The guard in invokeSystem runs before the switch, so this is the assertion
    // that keeps it from swallowing every unrecognised command.
    for (const command of ["resize_pill_window", "quit", "set_phase_now"]) {
      await expect(
        invokePreviewCommand(command),
        command,
      ).rejects.toMatchObject({
        name: "PreviewOperationError",
        command,
      } satisfies Partial<PreviewOperationError>);
    }
  });
});

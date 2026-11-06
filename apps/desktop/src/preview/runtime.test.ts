import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState } from "../store";
import { BrowserRecordingLease } from "../utils/browser-recording-lease";
import { NativeRecordingLease } from "../utils/native-recording-lease";
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

  const reserve = (ownerId: string) =>
    invokePreviewCommand<number>("recording_generation", { ownerId });

  it("keeps recordings owned in preview", async () => {
    const a = await reserve("a");
    const b = await reserve("b");
    await expect(
      invokePreviewCommand("start_recording", { ownerId: "a", generation: a }),
    ).resolves.toEqual({ sampleRate: 16000 });
    await expect(
      invokePreviewCommand("start_recording", { ownerId: "b", generation: b }),
    ).rejects.toThrow("already in progress");
    await expect(
      invokePreviewCommand("pause_recording", { ownerId: "b", generation: b }),
    ).rejects.toThrow("no longer owned");
    await expect(
      invokePreviewCommand("stop_recording", { ownerId: "b", generation: b }),
    ).rejects.toThrow("no longer owned");
    await expect(
      invokePreviewCommand("pause_recording", { ownerId: "a", generation: a }),
    ).resolves.toBeUndefined();
    await expect(
      invokePreviewCommand("resume_recording", { ownerId: "a", generation: a }),
    ).resolves.toBeUndefined();
    await expect(
      invokePreviewCommand("stop_recording", { ownerId: "a", generation: a }),
    ).resolves.toEqual({ samples: [], sampleRate: 16000 });
    const bAgain = await reserve("b");
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "b",
        generation: bAgain,
      }),
    ).resolves.toEqual({ sampleRate: 16000 });
    const old = await reserve("old");
    await expect(
      invokePreviewCommand("force_stop_recording"),
    ).resolves.toBeUndefined();
    await expect(
      invokePreviewCommand("stop_recording", { ownerId: "b", generation: b }),
    ).rejects.toThrow("no longer owned");
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "old",
        generation: old,
      }),
    ).rejects.toThrow("cancelled");
  });

  it("replays a stop until its exact owner acknowledges it", async () => {
    const token = await reserve("old");
    await invokePreviewCommand("start_recording", {
      ownerId: "old",
      generation: token,
    });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "old",
        generation: token,
      }),
    ).resolves.toEqual({ samples: [], sampleRate: 16000 });
    const next = await reserve("next");
    await invokePreviewCommand("start_recording", {
      ownerId: "next",
      generation: next,
    });
    await invokePreviewCommand("acknowledge_recording", {
      ownerId: "wrong",
      generation: token,
    });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "old",
        generation: token,
      }),
    ).resolves.toEqual({ samples: [], sampleRate: 16000 });
    await invokePreviewCommand("acknowledge_recording", {
      ownerId: "old",
      generation: token,
    });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "old",
        generation: token,
      }),
    ).rejects.toThrow("no longer owned");
    await expect(
      invokePreviewCommand("pause_recording", {
        ownerId: "next",
        generation: next,
      }),
    ).resolves.toBeUndefined();
    await invokePreviewCommand("discard_recording", {
      ownerId: "next",
      generation: next,
    });
  });

  it("bounds replay requests without deleting the recoverable result", async () => {
    const token = await reserve("bounded");
    await invokePreviewCommand("start_recording", {
      ownerId: "bounded",
      generation: token,
    });
    await invokePreviewCommand("stop_recording", {
      ownerId: "bounded",
      generation: token,
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(
        invokePreviewCommand("stop_recording", {
          ownerId: "bounded",
          generation: token,
        }),
      ).resolves.toEqual({ samples: [], sampleRate: 16000 });
    }
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "bounded",
        generation: token,
      }),
    ).rejects.toThrow("replay limit");
    await invokePreviewCommand("acknowledge_recording", {
      ownerId: "bounded",
      generation: token,
    });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "bounded",
        generation: token,
      }),
    ).rejects.toThrow("no longer owned");
  });

  it("recovers a stop that completed in the transport but lost its reply", async () => {
    let stops = 0;
    const transport = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        const result = await invokePreviewCommand(command, args);
        if (command === "stop_recording" && ++stops === 1)
          throw new Error("reply lost");
        return result;
      },
    );
    const lease = new NativeRecordingLease(transport, "lost-preview-reply");
    await lease.start(null);
    const token = lease.generation;
    expect(await lease.stop()).toEqual({
      samples: new Float32Array(),
      sampleRate: 16000,
    });
    expect(stops).toBe(2);
    expect(transport).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "lost-preview-reply",
      generation: token,
    });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "lost-preview-reply",
        generation: token,
      }),
    ).rejects.toThrow("no longer owned");
  });

  it("holds browser ownership across windows and rejects reset until release", async () => {
    const browser = await reserve("browser");
    await invokePreviewCommand("claim_browser_recording", {
      ownerId: "browser",
      generation: browser,
    });
    const native = await reserve("native");
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "native",
        generation: native,
      }),
    ).rejects.toThrow("already in progress");
    await expect(invokePreviewCommand("force_stop_recording")).rejects.toThrow(
      "not ended",
    );
    await invokePreviewCommand("release_browser_recording", {
      ownerId: "other",
      generation: browser,
    });
    const again = await reserve("again");
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "again",
        generation: again,
      }),
    ).rejects.toThrow("already in progress");
    await invokePreviewCommand("release_browser_recording", {
      ownerId: "browser",
      generation: browser,
    });
    const successor = await reserve("successor");
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "successor",
        generation: successor,
      }),
    ).resolves.toEqual({ sampleRate: 16000 });
    await invokePreviewCommand("discard_recording", {
      ownerId: "successor",
      generation: successor,
    });
  });

  it("coordinates browser and native leases using independent window transports", async () => {
    const browserTransport = (cmd: string, args?: Record<string, unknown>) =>
      invokePreviewCommand(cmd, args);
    const nativeTransport = (cmd: string, args?: Record<string, unknown>) =>
      invokePreviewCommand(cmd, args);
    const browser = new BrowserRecordingLease(browserTransport);
    await browser.acquire();
    const native = new NativeRecordingLease(nativeTransport, "separate-window");
    await expect(native.start(null)).rejects.toThrow("already in progress");
    await native.ensureReleasedAfterFailure();
    await browser.release();
    const next = new NativeRecordingLease(nativeTransport, "next-window");
    await expect(next.start(null)).resolves.toEqual({ sampleRate: 16000 });
    await next.cancel();
  });

  it("hands capture to a waiting dictation after the current test stops", async () => {
    const test = await reserve("test");
    await invokePreviewCommand("start_recording", {
      ownerId: "test",
      generation: test,
    });
    const dictation = await reserve("dictation");
    const waiting = invokePreviewCommand("start_recording", {
      ownerId: "dictation",
      generation: dictation,
      args: { waitForRelease: true },
    });
    await Promise.resolve();
    await invokePreviewCommand("stop_recording", {
      ownerId: "test",
      generation: test,
    });
    await expect(waiting).resolves.toEqual({ sampleRate: 16000 });
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "dictation",
        generation: dictation,
      }),
    ).resolves.toBeDefined();
  });

  it("stops a waiting admission without touching the current recording", async () => {
    const current = await reserve("current");
    await invokePreviewCommand("start_recording", {
      ownerId: "current",
      generation: current,
    });
    const pending = await reserve("pending");
    const waiting = invokePreviewCommand("start_recording", {
      ownerId: "pending",
      generation: pending,
      args: { waitForRelease: true },
    });
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "pending",
        generation: pending,
      }),
    ).resolves.toEqual({ samples: [], sampleRate: 0 });
    await rejected;
    await expect(
      invokePreviewCommand("pause_recording", {
        ownerId: "current",
        generation: current,
      }),
    ).resolves.toBeUndefined();
    await invokePreviewCommand("stop_recording", {
      ownerId: "current",
      generation: current,
    });
  });

  it("cancels a waiting capture when recording is reset", async () => {
    const test = await reserve("test");
    await invokePreviewCommand("start_recording", {
      ownerId: "test",
      generation: test,
    });
    const dictation = await reserve("dictation");
    const waiting = invokePreviewCommand("start_recording", {
      ownerId: "dictation",
      generation: dictation,
      args: { waitForRelease: true },
    });
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    await Promise.resolve();
    await invokePreviewCommand("force_stop_recording");
    await rejected;
  });

  it("discards an admission before a delayed start without stopping a different owner", async () => {
    const late = await reserve("late");
    const other = await reserve("other");
    await invokePreviewCommand("start_recording", {
      ownerId: "other",
      generation: other,
    });
    await invokePreviewCommand("discard_recording", {
      ownerId: "late",
      generation: late,
    });
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "late",
        generation: late,
      }),
    ).rejects.toThrow("cancelled");
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "other",
        generation: other,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects stale admissions and controls when an owner ID is reused", async () => {
    const old = await reserve("reused");
    await invokePreviewCommand("discard_recording", {
      ownerId: "reused",
      generation: old,
    });
    const current = await reserve("reused");
    expect(current).not.toBe(old);
    await expect(
      invokePreviewCommand("start_recording", {
        ownerId: "reused",
        generation: old,
      }),
    ).rejects.toThrow("cancelled");
    await invokePreviewCommand("discard_recording", {
      ownerId: "reused",
      generation: old,
    });
    await invokePreviewCommand("start_recording", {
      ownerId: "reused",
      generation: current,
    });
    await invokePreviewCommand("discard_recording", {
      ownerId: "reused",
      generation: old,
    });
    await expect(
      invokePreviewCommand("pause_recording", {
        ownerId: "reused",
        generation: old,
      }),
    ).rejects.toThrow("no longer owned");
    await expect(
      invokePreviewCommand("stop_recording", {
        ownerId: "reused",
        generation: current,
      }),
    ).resolves.toBeDefined();
  });

  it("does not release a newer browser capture with an old token", async () => {
    const old = await reserve("browser-reused");
    await invokePreviewCommand("claim_browser_recording", {
      ownerId: "browser-reused",
      generation: old,
    });
    await invokePreviewCommand("release_browser_recording", {
      ownerId: "browser-reused",
      generation: old,
    });
    const current = await reserve("browser-reused");
    await invokePreviewCommand("claim_browser_recording", {
      ownerId: "browser-reused",
      generation: current,
    });
    await invokePreviewCommand("release_browser_recording", {
      ownerId: "browser-reused",
      generation: old,
    });
    await expect(invokePreviewCommand("force_stop_recording")).rejects.toThrow(
      "not ended",
    );
    await invokePreviewCommand("release_browser_recording", {
      ownerId: "browser-reused",
      generation: current,
    });
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

  it("validates expansion-flag values before updating preferences", async () => {
    for (const [command, args] of [
      ["user_preferences_set_expansion_flags", {}],
      ["user_preferences_set_expansion_flags", { args: { flags: 42 } }],
      [
        "user_preferences_compare_set_expansion_flags",
        { args: { flags: "{}" } },
      ],
    ] as const) {
      await expect(invokePreviewCommand(command, args)).rejects.toThrow(
        "Expected string expansion flag arguments",
      );
    }
    const updated = await invokePreviewCommand<Record<string, unknown>>(
      "user_preferences_set_expansion_flags",
      { args: { flags: "new" } },
    );
    updated.expansionFlags = "mutated";
    await expect(
      invokePreviewCommand("user_preferences_get"),
    ).resolves.toMatchObject({ expansionFlags: "new" });
  });

  it("distinguishes a missing preference row for compare-and-set and set", async () => {
    applyPreviewScenario("welcome");
    await expect(
      invokePreviewCommand("user_preferences_compare_set_expansion_flags", {
        args: { expected: "{}", flags: "new" },
      }),
    ).resolves.toBeNull();
    await expect(
      invokePreviewCommand("user_preferences_set_expansion_flags", {
        args: { flags: "new" },
      }),
    ).rejects.toThrow("Preferences not found");
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

  it("routes transcription writes, audio stand-ins, and removal through preview history", async () => {
    const transcription = {
      id: "new",
      timestamp: 987654321,
      transcript: "first",
    };
    await expect(
      invokePreviewCommand("transcription_create", { transcription }),
    ).resolves.toEqual(transcription);
    const update = { ...transcription, transcript: "changed" };
    await expect(
      invokePreviewCommand("transcription_update", { transcription: update }),
    ).resolves.toEqual(update);
    expect(
      await invokePreviewCommand("transcription_list", {
        limit: 100,
        offset: 0,
      }),
    ).toContainEqual(update);
    for (const command of [
      "transcription_audio_load",
      "transcription_load_audio",
    ]) {
      await expect(
        invokePreviewCommand(command, { id: "new" }),
      ).resolves.toMatchObject({
        sampleRate: 16000,
        samples: expect.any(Array),
      });
    }
    await expect(
      invokePreviewCommand("transcription_import_audio"),
    ).resolves.toBeNull();
    await expect(
      invokePreviewCommand("purge_stale_transcription_audio"),
    ).resolves.toEqual([]);
    await invokePreviewCommand("transcription_delete", { id: "new" });
    expect(
      await invokePreviewCommand("transcription_list", {
        limit: 100,
        offset: 0,
      }),
    ).not.toContainEqual(update);
  });

  it("routes conversations and messages, cascading deletion only for the selected conversation", async () => {
    const conversation = { id: "c", title: "first", updatedAt: 100 };
    await invokePreviewCommand("conversation_create", { conversation });
    await invokePreviewCommand("conversation_update", {
      conversation: { ...conversation, title: "updated" },
    });
    const a = { id: "a", conversationId: "c", createdAt: 20, content: "a" };
    const b = { id: "b", conversationId: "c", createdAt: 10, content: "b" };
    const other = {
      id: "other",
      conversationId: "another",
      createdAt: 1,
      content: "other",
    };
    for (const message of [a, b, other])
      await invokePreviewCommand("chat_message_create", { message });
    expect(
      await invokePreviewCommand("chat_message_list", { conversationId: "c" }),
    ).toEqual([b, a]);
    const updated = { ...a, content: "changed" };
    await invokePreviewCommand("chat_message_update", { message: updated });
    await invokePreviewCommand("chat_message_delete_many", { ids: ["b"] });
    expect(
      await invokePreviewCommand("chat_message_list", { conversationId: "c" }),
    ).toEqual([updated]);
    await invokePreviewCommand("conversation_delete", { id: "c" });
    expect(
      await invokePreviewCommand("chat_message_list", { conversationId: "c" }),
    ).toEqual([]);
    expect(
      await invokePreviewCommand("chat_message_list", {
        conversationId: "another",
      }),
    ).toEqual([other]);
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

  it("routes user, tone, hotkey, and app-target operations without swallowing unknown commands", async () => {
    const user = { id: "u", name: "Preview" };
    await expect(
      invokePreviewCommand("user_set_one", { user }),
    ).resolves.toEqual(user);
    await expect(invokePreviewCommand("user_get_one")).resolves.toEqual(user);
    const tone = { id: "tone-new", name: "New" };
    await invokePreviewCommand("tone_upsert", { tone });
    await expect(
      invokePreviewCommand("tone_get", { id: tone.id }),
    ).resolves.toEqual(tone);
    expect(await invokePreviewCommand("tone_list")).toContainEqual(tone);
    await invokePreviewCommand("tone_delete", { id: tone.id });
    await expect(
      invokePreviewCommand("tone_get", { id: tone.id }),
    ).resolves.toBeNull();
    const hotkey = { id: "key-new", actionName: "test" };
    await invokePreviewCommand("hotkey_save", { hotkey });
    expect(await invokePreviewCommand("hotkey_list")).toContainEqual(hotkey);
    await invokePreviewCommand("hotkey_delete", { id: hotkey.id });
    expect(await invokePreviewCommand("hotkey_list")).not.toContainEqual(
      hotkey,
    );
    await expect(
      invokePreviewCommand("app_target_upsert", {
        args: { id: "target", name: "Target" },
      }),
    ).resolves.toMatchObject({ id: "target", name: "Target" });
    expect(await invokePreviewCommand("app_target_list")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "target" })]),
    );
    await expect(
      invokePreviewCommand("tone_unrecognized"),
    ).rejects.toBeInstanceOf(PreviewOperationError);
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
      const before =
        await invokePreviewCommand<
          { id: string; actionName: string; keys: string[] }[]
        >("hotkey_list");
      const expected = before.filter((hotkey) =>
        hotkey.actionName.startsWith("style-"),
      );
      await expect(
        invokePreviewCommand("hotkey_replace_style_hotkeys", {
          ...args,
          expected,
        }),
      ).rejects.toThrow();
      expect(await invokePreviewCommand("hotkey_list")).toEqual(before);
    },
  );

  it("replaces language hotkeys atomically and rejects collisions", async () => {
    const primary = { id: "dictate", actionName: "dictate", keys: ["Control"] };
    const old = {
      id: "language-fr",
      actionName: "additional-language:fr",
      keys: ["F"],
    };
    await invokePreviewCommand("hotkey_save", { hotkey: old });
    const before =
      await invokePreviewCommand<(typeof primary)[]>("hotkey_list");
    const expected = before.filter(
      (hotkey) =>
        hotkey.actionName === "dictate" ||
        hotkey.actionName.startsWith("additional-language:"),
    );
    await expect(
      invokePreviewCommand("hotkey_replace_dictation_language_hotkeys", {
        primary,
        expected,
        additional: [
          { id: "agent", actionName: "additional-language:es", keys: ["E"] },
        ],
      }),
    ).rejects.toThrow();
    expect(await invokePreviewCommand("hotkey_list")).toEqual(before);
    await invokePreviewCommand("hotkey_replace_dictation_language_hotkeys", {
      primary,
      expected,
      additional: [
        {
          id: "language-es",
          actionName: "additional-language:es",
          keys: ["E"],
        },
      ],
    });
    const after = await invokePreviewCommand<(typeof primary)[]>("hotkey_list");
    expect(after).toContainEqual(primary);
    expect(after.some((hotkey) => hotkey.id === "language-fr")).toBe(false);
    expect(after.some((hotkey) => hotkey.id === "language-es")).toBe(true);
    expect(after.some((hotkey) => hotkey.id === "agent")).toBe(true);
    await expect(
      invokePreviewCommand("hotkey_replace_dictation_language_hotkeys", {
        primary,
        expected,
        additional: [],
      }),
    ).rejects.toThrow("DICTATION_HOTKEYS_CHANGED");
    expect(await invokePreviewCommand("hotkey_list")).toEqual(after);
  });

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
        expected: [
          { id: "style-email", actionName: "style-email", keys: ["Alt", "E"] },
        ],
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

  it("rejects stale and colliding style replacements without altering saved data", async () => {
    const before =
      await invokePreviewCommand<
        { id: string; actionName: string; keys: string[] }[]
      >("hotkey_list");
    const expected = before.filter((hotkey) =>
      hotkey.actionName.startsWith("style-"),
    );
    await invokePreviewCommand("hotkey_save", {
      hotkey: { id: "style-new", actionName: "style-new", keys: ["N"] },
    });
    const after = await invokePreviewCommand<typeof before>("hotkey_list");
    await expect(
      invokePreviewCommand("hotkey_replace_style_hotkeys", {
        prefix: "style-",
        expected,
        hotkeys: [],
      }),
    ).rejects.toThrow("STYLE_HOTKEYS_CHANGED");
    const current = after.filter((hotkey) =>
      hotkey.actionName.startsWith("style-"),
    );
    for (const hotkey of [
      { id: "agent", actionName: "style-collision", keys: [] },
      { id: "x", actionName: "other", keys: [] },
    ]) {
      await expect(
        invokePreviewCommand("hotkey_replace_style_hotkeys", {
          prefix: "style-",
          expected: current,
          hotkeys: [hotkey],
        }),
      ).rejects.toThrow();
      expect(await invokePreviewCommand("hotkey_list")).toEqual(after);
    }
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

  it("returns independent receiver snapshots and resets the receiver with its scenario", async () => {
    const started = await invokePreviewCommand<Record<string, unknown>>(
      "remote_receiver_start",
    );
    expect(started).toEqual({
      enabled: true,
      deviceId: "preview-browser",
      deviceName: "Browser preview",
      devicePlatform: "macos",
      listenAddress: null,
      port: null,
      pairingCode: "PREVIEW",
      lastSenderDeviceId: null,
      lastEventId: null,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
      lastError: null,
      lastTargetClassName: null,
      lastTargetTitle: null,
      lastTargetEditable: null,
    });
    started.enabled = false;
    expect(await invokePreviewCommand("remote_receiver_status")).toMatchObject({
      enabled: true,
    });
    applyPreviewScenario("empty");
    expect(await invokePreviewCommand("remote_receiver_status")).toMatchObject({
      enabled: false,
    });
    expect(await invokePreviewCommand("remote_receiver_stop")).toMatchObject({
      enabled: false,
    });
    expect(await invokePreviewCommand("remote_receiver_start")).toMatchObject({
      enabled: true,
    });
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

  it.each([
    [
      "request_microphone_permission",
      { kind: "microphone", state: "authorized", promptShown: true },
    ],
    [
      "request_accessibility_permission",
      { kind: "accessibility", state: "authorized", promptShown: true },
    ],
    ["get_version", "0.1.6-preview"],
    ["get_identifier", "com.mausvoice.preview"],
    ["get_hotkey_strategy", "bridge"],
    ["get_key_listener_health", "healthy_grab"],
    ["supports_app_detection", true],
    ["supports_paste_keybinds", "per-app"],
    ["get_system_capabilities", { ramGb: 8, cpuCores: 8, gpus: [] }],
    ["get_system_volume", 0.7],
    ["set_system_volume", undefined],
    ["check_app_location_writable", true],
    ["get_keyboard_language", "en"],
    [
      "list_microphones",
      [{ label: "Preview microphone", isDefault: true, caution: false }],
    ],
    ["list_gpus", []],
    ["run_native_setup", "success"],
    ["export_diagnostics", true],
    ["export_transcription", true],
  ])(
    "returns the deterministic system response for %s",
    async (command, expected) => {
      await expect(invokePreviewCommand(command)).resolves.toEqual(expected);
    },
  );

  it("returns independent system response objects and refuses prototype-like command names", async () => {
    const first = await invokePreviewCommand<{ gpus: string[] }>(
      "get_system_capabilities",
    );
    first.gpus.push("corruption");
    await expect(
      invokePreviewCommand("get_system_capabilities"),
    ).resolves.toEqual({ ramGb: 8, cpuCores: 8, gpus: [] });
    await expect(invokePreviewCommand("__proto__")).rejects.toBeInstanceOf(
      PreviewOperationError,
    );
    await expect(
      invokePreviewCommand("storage_get_download_url"),
    ).resolves.toMatch(/^data:image\/svg\+xml,/);
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
      "quit_app",
      "remote_sender_disconnect",
      "reset_key_listener_state",
      "reset_native_setup",
      "restart_app",
      "restart_key_listener",
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

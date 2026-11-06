import type { Tone } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, warning, systemTone } = vi.hoisted(() => ({
  invoke: vi.fn(),
  warning: vi.fn(),
  systemTone: {
    id: "system",
    name: "System",
    promptTemplate: "p",
    isSystem: true,
    createdAt: 0,
    sortOrder: 1,
  } as Tone,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => ({ warning }) }));
vi.mock("../utils/tone.utils", () => ({
  getDefaultSystemTones: () => [systemTone],
}));

import { LocalToneRepo } from "./tone.repo";

beforeEach(() => {
  invoke.mockReset();
  warning.mockReset();
});

describe("LocalToneRepo", () => {
  it("merges and sorts native user styles with built-ins", async () => {
    invoke.mockResolvedValue([
      {
        id: "u",
        name: "User",
        promptTemplate: "q",
        createdAt: 7,
        sortOrder: 0,
        category: "Work",
      },
    ]);
    const tones = await new LocalToneRepo().listTones();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("tone_list");
    expect(tones.map((tone) => tone.id)).toEqual(["u", "system"]);
    expect(tones[0]).toMatchObject({ isSystem: false, category: "Work" });
  });

  it("falls back to built-ins if native listing fails", async () => {
    invoke.mockRejectedValue(new Error("offline"));
    await expect(new LocalToneRepo().listTones()).resolves.toEqual([
      systemTone,
    ]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("refuses to modify or delete built-ins", async () => {
    const repo = new LocalToneRepo();
    await expect(repo.upsertTone(systemTone)).rejects.toThrow(
      "System tones cannot be modified",
    );
    await expect(repo.deleteTone("system")).rejects.toThrow(
      "System tones cannot be deleted",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("persists and deletes user styles", async () => {
    const user: Tone = {
      ...systemTone,
      id: "user",
      name: "User",
      isSystem: false,
    };
    invoke.mockResolvedValueOnce({
      id: "user",
      name: "User",
      promptTemplate: "p",
      createdAt: 0,
      sortOrder: 1,
    });
    const repo = new LocalToneRepo();
    await expect(repo.upsertTone(user)).resolves.toMatchObject({
      id: "user",
      isSystem: false,
    });
    await repo.deleteTone("user");
    expect(invoke).toHaveBeenNthCalledWith(1, "tone_upsert", {
      tone: expect.objectContaining({ id: "user", category: null }),
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "tone_delete", { id: "user" });
  });
});

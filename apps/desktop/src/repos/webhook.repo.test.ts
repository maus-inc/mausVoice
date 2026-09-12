import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalWebhookRepo } from "./webhook.repo";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

describe("LocalWebhookRepo", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("creates a webhook with events and optional secret", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "wh-1",
      url: "https://example.com/hook",
      events: '["meeting.completed"]',
      secretSalt: null,
      secretCiphertext: null,
      enabled: true,
      createdAt: 1700000000000,
    });
    const repo = new LocalWebhookRepo();
    const result = await repo.createWebhook({
      id: "wh-1",
      url: "https://example.com/hook",
      events: ["meeting.completed"],
      secret: null,
      enabled: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("webhook_create", {
      args: {
        id: "wh-1",
        url: "https://example.com/hook",
        events: ["meeting.completed"],
        secret: null,
        enabled: true,
      },
    });
    expect(result.events).toEqual(["meeting.completed"]);
    expect(result.createdAt).toBe("2023-11-14T22:13:20.000Z");
  });

  it("emits events with metadata-only payloads", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const repo = new LocalWebhookRepo();
    await repo.emitEvent("meeting.completed", { id: "m-1" });
    expect(invokeMock).toHaveBeenCalledWith("webhook_emit", {
      event: "meeting.completed",
      payload: { id: "m-1" },
    });
  });
});

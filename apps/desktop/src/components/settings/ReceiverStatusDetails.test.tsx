import type { RemoteReceiverStatus } from "@maus-inc/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { ReceiverStatusDetails } from "./ReceiverStatusDetails";

const status: RemoteReceiverStatus = {
  enabled: false,
  deviceId: "receiver-1",
  deviceName: "Receiver",
  devicePlatform: "windows",
  listenAddress: null,
  port: null,
  pairingCode: "code",
  lastSenderDeviceId: null,
  lastEventId: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  lastError: null,
  lastTargetClassName: null,
  lastTargetTitle: null,
  lastTargetEditable: null,
};

const render = (overrides: Partial<RemoteReceiverStatus>) =>
  renderToStaticMarkup(
    createElement(IntlProvider, {
      locale: "en",
      children: createElement(ReceiverStatusDetails, {
        receiverStatus: { ...status, ...overrides },
      }),
    }),
  );

describe("receiver status details", () => {
  it("shows the identity without connection or delivery details when inactive", () => {
    const html = render({});
    expect(html).toContain("Device ID: receiver-1");
    expect(html).not.toContain("Connect address:");
    expect(html).not.toContain("Last delivery:");
    expect(html).not.toContain("Last target:");
  });

  it("uses fallback address and port when an enabled receiver has not reported them", () => {
    const html = render({ enabled: true });
    expect(html).toContain("Connect address: 127.0.0.1:unknown");
  });

  it("shows delivery, failure and target diagnostics", () => {
    const date = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("local date");
    try {
      const html = render({
        enabled: true,
        listenAddress: "192.168.1.8",
        port: 1234,
        lastSenderDeviceId: "sender-1",
        lastDeliveryStatus: "failed",
        lastDeliveryAt: "2025-01-01T00:00:00Z",
        lastError: "delivery failed",
        lastTargetClassName: "Tauri Window",
        lastTargetTitle: "mausVoice",
        lastTargetEditable: false,
      });
      expect(html).toContain("Connect address: 192.168.1.8:1234");
      expect(html).toContain("Last sender: sender-1");
      expect(html).toContain("Last delivery: failed at local date");
      expect(html).toContain("Last error: delivery failed");
      expect(html).toContain("Last target: Tauri Window (mausVoice)");
      expect(html).toContain(
        "last delivery targeted the mausVoice window itself",
      );
      expect(html).toContain("no editable text field was focused");
    } finally {
      date.mockRestore();
    }
  });

  it("shows a title-only target and status without a timestamp", () => {
    const html = render({
      lastDeliveryStatus: "ok",
      lastTargetTitle: "Editor",
      lastTargetEditable: false,
    });
    expect(html).toContain("Last delivery: ok");
    expect(html).toContain("Last target: unknown class (Editor)");
    expect(html).not.toContain("no editable text field was focused");
  });
});

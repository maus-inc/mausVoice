import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { MicrophoneOptionContent } from "./MicrophoneOptionContent";

const render = (element: React.ReactNode) =>
  renderToStaticMarkup(<IntlProvider locale="en">{element}</IntlProvider>);

describe("MicrophoneOptionContent", () => {
  it("displays default and caution status for a lower-quality device", () => {
    const html = render(
      <MicrophoneOptionContent
        option={{ label: "Headset", isDefault: true, caution: true }}
      />,
    );
    expect(html).toContain("Headset");
    expect(html).toContain("Default");
    expect(html).toContain("Caution");
    expect(html).toContain("May provide lower audio quality");
    expect(html).not.toContain("Currently unavailable");
  });

  it("prioritizes unavailable status, preserving desktop and preview labels", () => {
    const option = {
      label: "Old microphone",
      unavailable: true,
      caution: true,
    };
    const desktop = render(<MicrophoneOptionContent option={option} />);
    const preview = render(
      <MicrophoneOptionContent option={option} showUnavailableSuffix={false} />,
    );
    expect(desktop).toContain("Old microphone (unavailable)");
    expect(preview).not.toContain("Old microphone (unavailable)");
    expect(preview).toContain("Old microphone");
    for (const html of [desktop, preview]) {
      expect(html).toContain("Currently unavailable");
      expect(html).not.toContain("May provide lower audio quality");
      expect(html).not.toContain("Caution");
    }
  });
});

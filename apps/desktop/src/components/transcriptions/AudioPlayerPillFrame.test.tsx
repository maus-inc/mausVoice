import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AudioPlayerPillFrame } from "./AudioPlayerPillFrame";

describe("AudioPlayerPillFrame", () => {
  it("renders its children with the desktop default maximum width", () => {
    const html = renderToStaticMarkup(
      <AudioPlayerPillFrame>
        <button>Play</button>
      </AudioPlayerPillFrame>,
    );
    expect(html).toContain("<button>Play</button>");
    expect(html).toContain("max-width:350px");
    expect(html).toContain("align-self:flex-start");
  });

  it("uses the preview's configurable maximum width", () => {
    const html = renderToStaticMarkup(
      <AudioPlayerPillFrame maxWidth={280}>
        <span>Preview</span>
      </AudioPlayerPillFrame>,
    );
    expect(html).toContain("<span>Preview</span>");
    expect(html).toContain("max-width:280px");
  });
});

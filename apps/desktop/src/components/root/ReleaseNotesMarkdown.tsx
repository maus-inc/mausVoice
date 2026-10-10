import { openExternalUrl } from "../../utils/open-url.utils";
import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Release notes are remote content. Only absolute web links may cross the
// native opener boundary; relative links must never navigate the app route.
const webUrl = (href: string | undefined): string | null => {
  try {
    const url = new URL(href ?? "");
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  } catch {
    // An absent or relative target is text, not an app navigation.
  }
  return null;
};

const ReleaseNoteLink = ({ href, children }: ComponentProps<"a">) => {
  const url = webUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        // Every click is intercepted, whatever button it came from: this is a
        // desktop window, so the browser's answer to a modified or middle click
        // — a new tab — has nowhere to open, and the alternative to handling it
        // here is a webview that navigates away from the app to whatever the
        // release notes linked to. The href and target stay real, so the link's
        // context menu and assistive technology still see a link and can copy
        // its address.
        event.preventDefault();
        openExternalUrl(url, "a link in the release notes");
      }}
    >
      {children}
    </a>
  );
};

const components = { a: ReleaseNoteLink };

// Release bodies are written as GFM by the release pipeline, and the same
// dialect renders everywhere else in the app, so tables and strikethrough in
// the notes must not degrade to raw pipe text here.
export const ReleaseNotesMarkdown = ({ children }: { children: string }) => (
  <Markdown remarkPlugins={[remarkGfm]} components={components}>
    {children}
  </Markdown>
);

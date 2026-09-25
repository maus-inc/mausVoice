import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentProps } from "react";
import Markdown from "react-markdown";

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
        event.preventDefault();
        void openUrl(url).catch(() => {
          // Keep the app in place on failure, without logging a remote URL or
          // creating an unhandled event-handler rejection. The link can retry.
          console.error("Failed to open release-note link.");
        });
      }}
    >
      {children}
    </a>
  );
};

const components = { a: ReleaseNoteLink };

export const ReleaseNotesMarkdown = ({ children }: { children: string }) => (
  <Markdown components={components}>{children}</Markdown>
);

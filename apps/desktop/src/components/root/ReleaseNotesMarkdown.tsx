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
        // The anchor is real, so a middle click or a "copy link" still works;
        // the plugin is only for the plain left click. A failure keeps the app
        // where it is and the link can be retried.
        event.preventDefault();
        openExternalUrl(url);
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

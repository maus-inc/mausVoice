import type { ComponentProps } from "react";
import { openExternalUrl } from "../../utils/open-url.utils";

// Untrusted or remote markdown may only cross the native opener boundary via
// absolute http/https URLs without embedded credentials; relative or non-web
// schemes stay plain text so they never navigate the desktop webview.
const parseExternalWebUrl = (href: string | undefined): string | null => {
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

export const createMarkdownLink = (description: string) => {
  const MarkdownLink = ({ href, children }: ComponentProps<"a">) => {
    const url = parseExternalWebUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          // Intercept every click in the desktop window so modified clicks do
          // not open an unhosted tab or navigate the app webview, while
          // keeping the real href for context menus and assistive technology.
          event.preventDefault();
          openExternalUrl(url, description);
        }}
        onAuxClick={(event) => {
          // Middle-click fires `auxclick` rather than `click`; route it through
          // the native opener as well while leaving right-click context menus
          // (`button === 2`) untouched.
          if (event.button !== 1) return;
          event.preventDefault();
          openExternalUrl(url, description);
        }}
      >
        {children}
      </a>
    );
  };
  return MarkdownLink;
};

import { FormattedMessage } from "react-intl";
import type { ReactNode } from "react";
import type { SettingsPageId } from "../../utils/settings-registry";

/**
 * Page headings and intros, written as literals here so extraction sees them.
 *
 * The rail, the page header and search all read this one record, so a page
 * cannot be named one way in the rail and another in its own heading. The
 * registry stores the derived keys and `settings-registry.test.ts` fails if any
 * key stops resolving to the literal below.
 */
export const SETTINGS_PAGE_COPY: Record<
  SettingsPageId,
  { title: ReactNode; description: ReactNode }
> = {
  dictation: {
    title: <FormattedMessage defaultMessage="Dictation" />,
    description: (
      <FormattedMessage defaultMessage="How mausVoice listens and what it does with the words it hears." />
    ),
  },
  "ai-models": {
    title: <FormattedMessage defaultMessage="AI and models" />,
    description: (
      <FormattedMessage defaultMessage="Which models transcribe your speech, and which provider polishes it." />
    ),
  },
  shortcuts: {
    title: <FormattedMessage defaultMessage="Shortcuts" />,
    description: (
      <FormattedMessage defaultMessage="The keys that start dictation and the keys that switch styles." />
    ),
  },
  appearance: {
    title: <FormattedMessage defaultMessage="Appearance" />,
    description: (
      <FormattedMessage defaultMessage="How the pill, the menu bar icon, and celebrations look and behave." />
    ),
  },
  "privacy-data": {
    title: <FormattedMessage defaultMessage="Privacy and data" />,
    description: (
      <FormattedMessage defaultMessage="What stays on this computer, what leaves it, and how to remove it." />
    ),
  },
  system: {
    title: <FormattedMessage defaultMessage="System" />,
    description: (
      <FormattedMessage defaultMessage="Startup, input permissions, updates, diagnostics, and legal." />
    ),
  },
  account: {
    title: <FormattedMessage defaultMessage="Account" />,
    description: (
      <FormattedMessage defaultMessage="Your profile, your sign-in, and your account." />
    ),
  },
};

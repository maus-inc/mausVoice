import { Alert, Stack } from "@mui/material";
import { FormattedMessage } from "react-intl";
import type { Nullable } from "@maus-inc/types";
import type { RefObject } from "react";

import { SettingSection } from "../common/SettingSection";
import {
  MicrophoneSelector,
  type MicrophoneOption,
} from "../microphone/MicrophoneSelector";

/**
 * The device picker, its explanation, and the save-failure alert.
 *
 * Extracted from `MicrophoneDialog`, which was one function with a cyclomatic
 * complexity of 19. The three sections were already separate `<Stack>` blocks
 * with a `<Divider>` between them, so this boundary is the one the markup
 * already drew rather than a new one invented to satisfy a linter.
 */
export const PreferredMicrophoneSection = ({
  selected,
  saving,
  saveError,
  onSelect,
  onDevicesKnown,
  feedbackRef,
}: {
  readonly selected: Nullable<string>;
  readonly saving: boolean;
  readonly saveError: boolean;
  readonly onSelect: (next: Nullable<string>) => void;
  readonly onDevicesKnown: (devices: MicrophoneOption[]) => void;
  readonly feedbackRef: RefObject<HTMLDivElement | null>;
}) => (
  <Stack spacing={1.5}>
    <SettingSection
      title={<FormattedMessage defaultMessage="Preferred microphone" />}
      description={
        <FormattedMessage defaultMessage="Choose which microphone mausVoice should use when recording. Automatic picks the best available device each time." />
      }
      sx={{ pb: 0.5 }}
    />
    <MicrophoneSelector
      value={selected ?? null}
      onChange={onSelect}
      disabled={saving}
      onDevicesKnown={onDevicesKnown}
    />
    {saveError && (
      // The alert is the announcement as well as the message: it is rendered
      // only when a save failed, so a screen reader reads it on insertion
      // without a live region that would repeat the toast.
      <Alert ref={feedbackRef} severity="error">
        <FormattedMessage defaultMessage="Failed to save microphone preference. Please try again." />
      </Alert>
    )}
  </Stack>
);

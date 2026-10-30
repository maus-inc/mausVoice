import { Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import {
  SETTING_SECTIONS,
  type SettingSectionId,
} from "../../utils/settings-registry";

/**
 * DOM id the settings page wraps each section in. The page already renders one
 * per section, so the rail scrolls to those same nodes rather than adding a
 * second set of targets.
 */
export const sectionAnchorId = (section: SettingSectionId): string =>
  `section-${section}`;

/** Label for a section, switching on the id so each stays an extracted message. */
export const sectionLabelOf = (section: SettingSectionId) => {
  switch (section) {
    case "general":
      return <FormattedMessage defaultMessage="General" />;
    case "dictation":
      return <FormattedMessage defaultMessage="Dictation" />;
    case "ai-processing":
      return <FormattedMessage defaultMessage="AI and processing" />;
    case "pill-appearance":
      return <FormattedMessage defaultMessage="Pill and appearance" />;
    case "shortcuts":
      return <FormattedMessage defaultMessage="Shortcuts" />;
    case "privacy-data":
      return <FormattedMessage defaultMessage="Privacy and data" />;
    case "updates":
      return <FormattedMessage defaultMessage="Updates" />;
    case "advanced":
      return <FormattedMessage defaultMessage="Advanced" />;
  }
};

/**
 * Which section a set of measured section tops belongs to at a given offset.
 *
 * The last section whose top has passed the offset wins, so the rail highlights
 * the section the reader is inside rather than the one leaving the viewport.
 * Exported for direct testing, because getting this backwards looks plausible
 * on screen and is easy to ship.
 */
export const sectionFromScrollTop = (
  tops: ReadonlyArray<readonly [SettingSectionId, number]>,
  scrollTop: number,
): SettingSectionId | null => {
  let active: SettingSectionId | null = null;
  for (const [section, top] of tops) {
    if (top <= scrollTop) {
      active = section;
    } else {
      break;
    }
  }
  return active;
};

/**
 * In-page navigation for the settings sections.
 *
 * Eight sections in one scroll gave no way to see what lived where and no way
 * to reach Advanced without reading through everything above it. Built from the
 * same registry that drives search, so a section cannot exist in one and be
 * missing from the other.
 */
export const SettingsSectionNav = ({
  active,
  onSelect,
}: {
  active: SettingSectionId | null;
  onSelect: (section: SettingSectionId) => void;
}) => (
  <Stack
    component="nav"
    aria-label="Settings sections"
    spacing={0.25}
    sx={{
      width: 168,
      flexShrink: 0,
      position: "sticky",
      top: 0,
      alignSelf: "flex-start",
      display: { xs: "none", md: "flex" },
    }}
  >
    {SETTING_SECTIONS.map((section) => {
      const selected = active === section.id;
      return (
        <Typography
          key={section.id}
          component="button"
          type="button"
          onClick={() => onSelect(section.id)}
          aria-current={selected ? "true" : undefined}
          sx={{
            appearance: "none",
            border: "none",
            background: selected ? "action.selected" : "transparent",
            color: selected ? "text.primary" : "text.secondary",
            font: "inherit",
            fontSize: "0.8125rem",
            textAlign: "left",
            px: 1,
            py: 0.5,
            borderRadius: 0.5,
            cursor: "pointer",
            transition:
              "background-color var(--duration-fast) ease, color var(--duration-fast) ease",
            "&:hover": {
              backgroundColor: "action.hover",
              color: "text.primary",
            },
            "&:focus-visible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: -2,
            },
          }}
        >
          {sectionLabelOf(section.id)}
        </Typography>
      );
    })}
  </Stack>
);

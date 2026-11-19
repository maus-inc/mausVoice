import { Box, MenuItem, Select, type SelectChangeEvent } from "@mui/material";
import type { PillLocateGestureModifier } from "@maus-inc/types";
import { useIntl } from "react-intl";
import { keycapDashboardSize } from "../../styles/keycap";
import { getKeycapLegend } from "../../utils/keyboard.utils";
import { Keycap3d } from "../common/Keycap3d";
import {
  chromeSelectMenuProps,
  chromeSelectMenuItemSx,
} from "../common/chromeMenu";

const MODIFIERS = ["alt", "shift", "control"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Key names the cap legend recognises. The cap renders the platform glyph. */
const MODIFIER_KEY_NAMES: Record<Modifier, string> = {
  alt: "Alt",
  shift: "Shift",
  control: "Control",
};

const Keycap = ({ modifier }: { modifier: Modifier }) => (
  <Keycap3d
    {...getKeycapLegend(MODIFIER_KEY_NAMES[modifier])}
    view="front"
    size={keycapDashboardSize}
  />
);

const DoubleTap = ({ modifier }: { modifier: Modifier }) => (
  <Box
    component="span"
    aria-hidden="true"
    sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
  >
    <Keycap modifier={modifier} />
    <Box
      component="span"
      sx={{ color: "text.secondary", fontSize: "0.875rem", lineHeight: 1 }}
    >
      +
    </Box>
    <Keycap modifier={modifier} />
  </Box>
);

/**
 * Chooses the single modifier whose double tap replays the pill outline.
 *
 * The trigger and every menu row show the chosen cap twice with a plus between
 * them, so the value reads as the gesture itself rather than as a key name. The
 * word beside each pair in the menu names the key for anyone who cannot read
 * the cap.
 */
export const PillLocateModifierSetting = ({
  value,
  onChange,
  ariaLabel,
}: {
  value: PillLocateGestureModifier;
  onChange: (value: PillLocateGestureModifier) => void | Promise<unknown>;
  ariaLabel: string;
}) => {
  const intl = useIntl();
  const labels: Record<Modifier, string> = {
    alt: intl.formatMessage({ defaultMessage: "Alt" }),
    shift: intl.formatMessage({ defaultMessage: "Shift" }),
    control: intl.formatMessage({ defaultMessage: "Control" }),
  };
  const disabled = intl.formatMessage({ defaultMessage: "Disabled" });
  const valueLabel = value === "none" ? disabled : labels[value];

  return (
    <Select<PillLocateGestureModifier>
      size="small"
      fullWidth
      displayEmpty
      value={value}
      aria-label={`${ariaLabel}: ${valueLabel}`}
      sx={{ minWidth: { xs: 168, sm: 192 } }}
      onChange={(event: SelectChangeEvent) =>
        void Promise.resolve(
          onChange(event.target.value as PillLocateGestureModifier),
        ).catch(() => {})
      }
      renderValue={(selected) =>
        selected === "none" ? (
          <Box component="span">{disabled}</Box>
        ) : (
          <DoubleTap modifier={selected} />
        )
      }
      MenuProps={chromeSelectMenuProps}
    >
      <MenuItem value="none" aria-label={disabled} sx={chromeSelectMenuItemSx}>
        {disabled}
      </MenuItem>
      {MODIFIERS.map((modifier) => (
        <MenuItem
          key={modifier}
          value={modifier}
          aria-label={labels[modifier]}
          // The pair and its word are one unit, and grouping them keeps the
          // menu no wider than the trigger, so its edges line up with the field.
          sx={{
            ...chromeSelectMenuItemSx,
            gap: 1,
            justifyContent: "flex-start",
          }}
        >
          <DoubleTap modifier={modifier} />
          <Box component="span">{labels[modifier]}</Box>
        </MenuItem>
      ))}
    </Select>
  );
};

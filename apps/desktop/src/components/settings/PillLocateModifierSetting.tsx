import { Box } from "@mui/material";
import type { PillLocateGestureModifier } from "@maus-inc/types";
import { useIntl } from "react-intl";
import { keycapDashboardSize } from "../../styles/keycap";
import { getKeycapLegend } from "../../utils/keyboard.utils";
import { Keycap3d } from "../common/Keycap3d";
import { SettingSelect, type SettingSelectOption } from "./SettingRowControls";

type Modifier = Exclude<PillLocateGestureModifier, "none">;

const MODIFIERS = [
  "alt",
  "shift",
  "control",
] as const satisfies readonly Modifier[];

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
  onChange: (value: PillLocateGestureModifier) => unknown;
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

  const options: SettingSelectOption<PillLocateGestureModifier>[] = [
    { value: "none", label: disabled, ariaLabel: disabled },
    ...MODIFIERS.map((modifier) => ({
      value: modifier,
      label: labels[modifier],
      node: (
        <Box component="span" sx={{ display: "inline-flex", gap: 1 }}>
          <DoubleTap modifier={modifier} />
          <Box component="span">{labels[modifier]}</Box>
        </Box>
      ),
      ariaLabel: labels[modifier],
    })),
  ];

  return (
    <SettingSelect<PillLocateGestureModifier>
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={`${ariaLabel}: ${valueLabel}`}
      displayEmpty
      minWidth={{ xs: 168, sm: 192 }}
      renderValue={(selected) =>
        selected === "none" ? (
          <Box component="span">{disabled}</Box>
        ) : (
          <DoubleTap modifier={selected} />
        )
      }
    />
  );
};

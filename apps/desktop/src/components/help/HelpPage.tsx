import { Button, Stack, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { ink, onDark } from "../../styles/palette";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { ONBOARDING_TIPS, tipAction } from "../../utils/tips";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";
import {
  TIP_COPY,
  TIP_ICONS,
  TipCardFrame,
  tipActionButtonSx,
} from "../onboarding/TipCard";

/**
 * Recessed surface styling for dismissed tips on the Help page.
 *
 * Dropping the card onto the `level0` canvas with a dashed hairline and a
 * slightly softened title makes dismissed tips distinct from active `level1`
 * cards without whole-card opacity, which pushed secondary body copy below
 * WCAG AA contrast and dimmed the "Show again" control.
 */
const dismissedTipCardSx: SxProps<Theme> = (theme) => ({
  bgcolor: "transparent",
  borderStyle: "dashed",
  borderColor: ink(0.18),
  "& [data-tip-title='true']": { color: ink(0.76) },
  "& [data-tip-icon='true']": { opacity: 0.72 },
  ...theme.applyStyles("dark", {
    borderColor: onDark(0.18),
    "& [data-tip-title='true']": { color: onDark(0.76) },
  }),
});

const showAgainButtonSx: SxProps<Theme> = {
  ...tipActionButtonSx,
  fontWeight: 500,
  px: 1.25,
  color: "text.secondary",
  "&:hover": {
    color: "text.primary",
    bgcolor: "action.hover",
  },
};

export default function HelpPage() {
  const navigate = useNavigate();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);
  // The listing shows every tip, including the ones for features that are off.
  // The switch is read here rather than hidden in the card: a tip is how
  // someone learns the feature exists, so it stays, and its action leads to the
  // row that turns the feature on instead of the route that feature owns.
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);
  const features = { assistantModeEnabled };

  return (
    <DashboardEntryLayout>
      <Stack spacing={1.5} sx={{ mb: 4 }}>
        {/* This route's only heading, and the shell renders no `h1`, so
            `component` supplies the level while `variant` matches the other
            dashboard page headers (`ScrollListPage`, `SettingsLayout`). */}
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          <FormattedMessage defaultMessage="Help and onboarding" />
        </Typography>
        <Typography
          variant="subtitle1"
          sx={{ color: "text.secondary", maxWidth: "56ch" }}
        >
          <FormattedMessage defaultMessage="Short guides for the features first run skips. Dismissed tips can be shown again here." />
        </Typography>
      </Stack>

      <Stack spacing={1.5}>
        {ONBOARDING_TIPS.map((tip) => {
          const copy = TIP_COPY[tip.id];
          const isDismissed = dismissed.includes(tip.id);
          const action = tipAction(tip, features);
          const hasActions = Boolean(action) || isDismissed;
          return (
            <TipCardFrame
              key={tip.id}
              icon={TIP_ICONS[tip.id]}
              title={copy.title}
              body={copy.body}
              headingLevel="h2"
              // Dismissed tips recede onto the canvas with a dashed hairline
              // rather than dimming the whole card via opacity, keeping copy
              // and actions legible while separating them from active tips.
              sx={isDismissed ? dismissedTipCardSx : undefined}
              actions={
                hasActions ? (
                  <>
                    {action && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => navigate(action.href)}
                        sx={tipActionButtonSx}
                      >
                        {action.isSetup
                          ? (copy.setupAction ?? copy.action)
                          : copy.action}
                      </Button>
                    )}
                    {isDismissed && (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => resetTip(tip.id)}
                        sx={showAgainButtonSx}
                      >
                        <FormattedMessage defaultMessage="Show again" />
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            />
          );
        })}
      </Stack>
    </DashboardEntryLayout>
  );
}

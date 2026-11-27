import { Box, Button, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { ONBOARDING_TIPS, tipAction } from "../../utils/tips";
import { TIP_COPY, TIP_ICONS, TipCardFrame } from "../onboarding/TipCard";

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
    <Box sx={{ flexGrow: 1, height: "100%", pb: 2, pr: 2 }}>
      <Box sx={{ height: "100%", overflow: "auto" }}>
        <Stack spacing={2} sx={{ maxWidth: 640, pt: 1 }}>
          {/* This route's only heading, and the shell renders no `h1`, so
              `component` supplies the level while `variant` keeps the size.
              The size and weight match the other dashboard page headers. */}
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            <FormattedMessage defaultMessage="Help and onboarding" />
          </Typography>
          <Typography variant="subtitle1" color="text.secondary">
            <FormattedMessage defaultMessage="Short guides for the features first run skips. Dismissed tips can be shown again here." />
          </Typography>
          {ONBOARDING_TIPS.map((tip) => {
            const copy = TIP_COPY[tip.id];
            const isDismissed = dismissed.includes(tip.id);
            const action = tipAction(tip, features);
            return (
              <TipCardFrame
                key={tip.id}
                icon={TIP_ICONS[tip.id]}
                title={copy.title}
                body={copy.body}
                headingLevel="h2"
                // This list is where dismissed tips are browsed, so the dimming
                // is the only signal distinguishing them from live ones. It
                // belongs to the card rather than to `TipCardFrame`, which also
                // serves first-run tips that cannot be dismissed at all.
                sx={{ opacity: isDismissed ? 0.65 : 1 }}
                actions={
                  <>
                    {action && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => navigate(action.href)}
                        sx={{ textTransform: "none", borderRadius: 999 }}
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
                      >
                        <FormattedMessage defaultMessage="Show again" />
                      </Button>
                    )}
                  </>
                }
              />
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

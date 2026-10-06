import { ArrowRight } from "lucide-react";
import { Box, Button, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { ONBOARDING_TIPS } from "../../utils/tips";
import { TIP_COPY, TIP_ICONS, TipCardFrame } from "../onboarding/TipCard";

export default function HelpPage() {
  const navigate = useNavigate();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);

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
            return (
              <TipCardFrame
                key={tip.id}
                icon={TIP_ICONS[tip.id]}
                title={copy.title}
                body={copy.body}
                // This list is where dismissed tips are browsed, so the dimming
                // is the only signal distinguishing them from live ones. It
                // belongs to the card rather than to `TipCardFrame`, which also
                // serves first-run tips that cannot be dismissed at all.
                sx={{ opacity: isDismissed ? 0.65 : 1 }}
                actions={
                  <>
                    {tip.href && (
                      <Button
                        size="small"
                        variant="outlined"
                        endIcon={
                          <ArrowRight size={14} strokeWidth={2} aria-hidden />
                        }
                        onClick={() => navigate(tip.href as string)}
                        sx={{ textTransform: "none", borderRadius: 999 }}
                      >
                        {copy.action}
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

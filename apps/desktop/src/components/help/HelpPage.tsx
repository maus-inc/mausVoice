import { Box, Button, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { ONBOARDING_TIPS } from "../../utils/tips";
import { TIP_COPY, TipCardFrame } from "../onboarding/TipCard";

export default function HelpPage() {
  const navigate = useNavigate();
  const dismissed = useAppStore((s) => s.local.dismissedTipIds ?? []);

  return (
    <Box sx={{ flexGrow: 1, height: "100%", pb: 2, pr: 2 }}>
      <Box
        sx={{
          height: "100%",
          overflow: "auto",
          bgcolor: "level1",
          borderRadius: 2,
          p: 3,
        }}
      >
        <Stack spacing={2} sx={{ maxWidth: 640 }}>
          {/* This route's only heading, and the shell renders no `h1`, so
              `component` supplies the level while `variant` keeps the size. */}
          <Typography variant="h6" component="h1">
            <FormattedMessage defaultMessage="Help and onboarding" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Short guides for the features first run skips. Dismissed tips can be shown again here." />
          </Typography>
          {ONBOARDING_TIPS.map((tip) => {
            const copy = TIP_COPY[tip.id];
            const isDismissed = dismissed.includes(tip.id);
            return (
              <TipCardFrame
                key={tip.id}
                title={copy.title}
                body={copy.body}
                actions={
                  <Stack direction="row" spacing={1}>
                    {tip.href && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => navigate(tip.href as string)}
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
                  </Stack>
                }
              />
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

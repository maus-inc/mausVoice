import { Box, Button, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useNavigate } from "react-router-dom";
import { resetTip } from "../../actions/onboarding.actions";
import { useAppStore } from "../../store";
import { ONBOARDING_TIPS } from "../../utils/tips";
import { TIP_COPY } from "../onboarding/TipCard";

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
          <Typography variant="h6">
            <FormattedMessage defaultMessage="Help and onboarding" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            <FormattedMessage defaultMessage="Short guides for the features first run skips. Dismissed tips can be shown again here." />
          </Typography>
          {ONBOARDING_TIPS.map((tip) => {
            const copy = TIP_COPY[tip.id];
            const isDismissed = dismissed.includes(tip.id);
            return (
              <Box
                key={tip.id}
                sx={{
                  p: 2,
                  borderRadius: 2,
                  border: 1,
                  borderColor: "divider",
                  opacity: isDismissed ? 0.65 : 1,
                }}
              >
                <Stack spacing={1}>
                  <Typography variant="subtitle2">{copy.title}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {copy.body}
                  </Typography>
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
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

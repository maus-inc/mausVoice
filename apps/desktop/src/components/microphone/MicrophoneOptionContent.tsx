import { Box, Chip, Stack, Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";

/** Shared option presentation; the surrounding Select owns each MenuItem. */
export const MicrophoneOptionContent = ({
  option,
  showUnavailableSuffix = true,
}: {
  option: {
    label: string;
    unavailable?: boolean;
    caution?: boolean;
    isDefault?: boolean;
  };
  showUnavailableSuffix?: boolean;
}) => (
  <Stack
    direction="row"
    spacing={2}
    sx={{ justifyContent: "space-between", width: "100%" }}
  >
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      <Typography>
        {option.unavailable && showUnavailableSuffix ? (
          <FormattedMessage
            id="microphone_unavailable"
            defaultMessage="{microphone} (unavailable)"
            values={{ microphone: option.label }}
          />
        ) : (
          option.label
        )}
      </Typography>
      {option.unavailable && (
        <Typography variant="caption" sx={{ color: "warning.main" }}>
          <FormattedMessage
            id="currently_unavailable"
            defaultMessage="Currently unavailable"
          />
        </Typography>
      )}
      {option.caution && !option.unavailable && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          <FormattedMessage
            id="may_provide_lower_audio_quality"
            defaultMessage="May provide lower audio quality"
          />
        </Typography>
      )}
    </Box>
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
      {option.isDefault && (
        <Chip
          size="small"
          label={<FormattedMessage id="default" defaultMessage="Default" />}
          color="primary"
          variant="outlined"
        />
      )}
      {option.caution && !option.unavailable && (
        <Chip
          size="small"
          label={<FormattedMessage id="caution" defaultMessage="Caution" />}
          color="warning"
          variant="outlined"
        />
      )}
    </Stack>
  </Stack>
);

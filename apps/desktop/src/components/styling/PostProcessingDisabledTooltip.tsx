import { Box, Link } from "@mui/material";
import type { ReactElement } from "react";
import { FormattedMessage } from "react-intl";
import { openPostProcessingSettings } from "../../actions/settings.actions";
import { ConditionalTooltip } from "../common/ConditionalTooltip";

type PostProcessingDisabledTooltipProps = {
  disabled: boolean;
  children: ReactElement;
};

export const PostProcessingDisabledTooltip = ({
  disabled,
  children,
}: PostProcessingDisabledTooltipProps) => {
  return (
    <ConditionalTooltip
      enabled={disabled}
      title={
        <Box>
          <FormattedMessage defaultMessage="Post-processing must be enabled to use writing styles." />{" "}
          <Link
            component="button"
            color="inherit"
            sx={{ verticalAlign: "baseline" }}
            onClick={openPostProcessingSettings}
          >
            <FormattedMessage defaultMessage="Fix issue" />
          </Link>
        </Box>
      }
    >
      <span>{children}</span>
    </ConditionalTooltip>
  );
};

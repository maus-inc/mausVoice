import { Box, Link } from "@mui/material";
import type { ReactElement } from "react";
import { useCallback } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState } from "../../store";
import { ConditionalTooltip } from "../common/ConditionalTooltip";

export const PostProcessingDisabledTooltip = ({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactElement;
}) => {
  const openPostProcessingSettings = useCallback(() => {
    produceAppState((draft) => {
      draft.settings.aiPostProcessingDialogOpen = true;
    });
  }, []);

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

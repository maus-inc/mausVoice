import { Tooltip } from "@mui/material";
import type { TooltipProps } from "@mui/material";

export const ConditionalTooltip = ({
  enabled = true,
  children,
  ...props
}: TooltipProps & { enabled?: boolean }) => {
  if (!enabled) {
    return <>{children}</>;
  }

  return <Tooltip {...props}>{children}</Tooltip>;
};

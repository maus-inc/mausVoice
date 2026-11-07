import { Check, OpenInNew } from "@mui/icons-material";
import { Button } from "@mui/material";
import { FormattedMessage } from "react-intl";

type PermissionAccessButtonProps = {
  isAuthorized: boolean;
  requesting: boolean;
  onAllow: () => void;
};

/**
 * Shared grant/denied state button for the permission onboarding steps. When
 * the permission is already granted the button is a disabled confirmation;
 * otherwise it opens the system permission dialog.
 */
export const PermissionAccessButton = ({
  isAuthorized,
  requesting,
  onAllow,
}: PermissionAccessButtonProps) => {
  if (isAuthorized) {
    return (
      <Button
        variant="outlined"
        color="success"
        startIcon={<Check />}
        disabled
        sx={{ alignSelf: "flex-start" }}
      >
        <FormattedMessage defaultMessage="Access granted" />
      </Button>
    );
  }

  return (
    <Button
      variant="outlined"
      onClick={onAllow}
      disabled={requesting}
      endIcon={<OpenInNew />}
      sx={{ alignSelf: "flex-start" }}
    >
      <FormattedMessage defaultMessage="Allow access" />
    </Button>
  );
};

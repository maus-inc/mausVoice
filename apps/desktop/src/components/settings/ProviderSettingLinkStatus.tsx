import { Alert, Button } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useLocation } from "react-router-dom";
import { loadApiKeys } from "../../actions/api-key.actions";
import { useAppStore } from "../../store";
import { logOnRejection } from "../../utils/promise.utils";
import type { SettingAvailability } from "../../utils/settings-registry";
import { settingAnchorId } from "./settings-routes";

const PROVIDER_SETTINGS = [
  "where_your_dictation_audio_goes",
  "elevenlabs_keyterms",
] as const;

/** Explain a provider-dependent deep link until its target can be determined. */
export const ProviderSettingLinkStatus = ({
  availability,
}: {
  availability: SettingAvailability;
}) => {
  const { hash } = useLocation();
  const status = useAppStore((state) => state.settings.apiKeysStatus);
  const key = PROVIDER_SETTINGS.find(
    (item) => `#${settingAnchorId(item)}` === hash,
  );
  if (!key || availability[key] === true) return null;

  return (
    <Alert
      severity={status === "error" ? "warning" : "info"}
      role="status"
      sx={{ mb: 3 }}
      action={
        status === "error" ? (
          <Button
            size="small"
            onClick={() =>
              logOnRejection(loadApiKeys(), "settings: loadApiKeys")
            }
          >
            <FormattedMessage defaultMessage="Try again" />
          </Button>
        ) : undefined
      }
    >
      {status === "error" ? (
        <FormattedMessage defaultMessage="Could not load provider settings." />
      ) : status === "success" ? (
        <FormattedMessage defaultMessage="This setting is not available." />
      ) : (
        <FormattedMessage defaultMessage="Loading provider settings…" />
      )}
    </Alert>
  );
};

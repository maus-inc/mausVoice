import type { ApiKeyCredentialIssue } from "@maus-inc/types";
import { defineMessages, useIntl, type MessageDescriptor } from "react-intl";

const API_KEY_CREDENTIAL_ISSUE_MESSAGES = defineMessages({
  legacy_encryption: {
    defaultMessage:
      "This key was imported from Voquill's older encryption format and could not be unlocked. Enter your key again to re-encrypt it with mausVoice.",
  },
  decryption_failed: {
    defaultMessage:
      "The saved key could not be decrypted on this computer. Enter your key again to replace it.",
  },
  missing_endpoint: {
    defaultMessage: "Enter a valid endpoint URL to use this provider.",
  },
  missing_region: {
    defaultMessage: "Enter an Azure region to use this provider.",
  },
  missing_key: {
    defaultMessage: "Enter a valid API key to use this provider.",
  },
  invalid_key_format: {
    defaultMessage:
      "The saved API key has an invalid format. Enter a valid key to replace it.",
  },
  fallback: {
    defaultMessage:
      "The saved key configuration is incomplete or invalid. Enter a valid key to continue.",
  },
});

const ISSUE_DESCRIPTOR_MAP: Record<ApiKeyCredentialIssue, MessageDescriptor> = {
  legacy_encryption: API_KEY_CREDENTIAL_ISSUE_MESSAGES.legacy_encryption,
  decryption_failed: API_KEY_CREDENTIAL_ISSUE_MESSAGES.decryption_failed,
  missing_endpoint: API_KEY_CREDENTIAL_ISSUE_MESSAGES.missing_endpoint,
  missing_region: API_KEY_CREDENTIAL_ISSUE_MESSAGES.missing_region,
  missing_key: API_KEY_CREDENTIAL_ISSUE_MESSAGES.missing_key,
  invalid_key_format: API_KEY_CREDENTIAL_ISSUE_MESSAGES.invalid_key_format,
};

export const ApiKeyAttentionMessage = ({
  issue,
}: {
  issue: ApiKeyCredentialIssue | null;
}) => {
  const intl = useIntl();
  const descriptor =
    issue !== null
      ? ISSUE_DESCRIPTOR_MAP[issue]
      : API_KEY_CREDENTIAL_ISSUE_MESSAGES.fallback;
  return <>{intl.formatMessage(descriptor)}</>;
};

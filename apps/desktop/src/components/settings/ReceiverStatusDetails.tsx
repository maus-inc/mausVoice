import { Stack, Typography } from "@mui/material";
import type { RemoteReceiverStatus } from "@maus-inc/types";
import { FormattedMessage } from "react-intl";

const ReceiverTargetDetails = ({
  receiverStatus,
}: {
  receiverStatus: RemoteReceiverStatus;
}) => {
  const lastTargetLooksLikeMausVoice =
    receiverStatus.lastTargetClassName === "Tauri Window";
  const lastTargetMissingEditableField =
    receiverStatus.lastTargetEditable === false &&
    receiverStatus.lastDeliveryStatus === "failed";

  return (
    <>
      {(receiverStatus.lastTargetClassName ||
        receiverStatus.lastTargetTitle) && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            wordBreak: "break-word",
          }}
        >
          <FormattedMessage
            defaultMessage="Last target: {className}{title}"
            values={{
              className: receiverStatus.lastTargetClassName ?? "unknown class",
              title: receiverStatus.lastTargetTitle
                ? ` (${receiverStatus.lastTargetTitle})`
                : "",
            }}
          />
        </Typography>
      )}
      {lastTargetLooksLikeMausVoice && (
        <Typography
          variant="caption"
          sx={{
            color: "warning.main",
            wordBreak: "break-word",
          }}
        >
          <FormattedMessage defaultMessage="The last delivery targeted the mausVoice window itself. Focus the destination app on the receiver machine before sending text." />
        </Typography>
      )}
      {lastTargetMissingEditableField && (
        <Typography
          variant="caption"
          sx={{
            color: "warning.main",
            wordBreak: "break-word",
          }}
        >
          <FormattedMessage defaultMessage="The last target window was active, but no editable text field was focused. Click back into the destination text field on the receiver machine before sending text." />
        </Typography>
      )}
    </>
  );
};

export const ReceiverStatusDetails = ({
  receiverStatus,
}: {
  receiverStatus: RemoteReceiverStatus;
}) => {
  const lastDeliveryTimeLabel = receiverStatus.lastDeliveryAt
    ? new Date(receiverStatus.lastDeliveryAt).toLocaleString()
    : null;

  return (
    <Stack spacing={0.5} sx={{ mt: -1 }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        <FormattedMessage
          defaultMessage="Device ID: {deviceId}"
          values={{ deviceId: receiverStatus.deviceId }}
        />
      </Typography>
      {receiverStatus.enabled && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="Connect address: {address}:{port}"
            values={{
              address: receiverStatus.listenAddress ?? "127.0.0.1",
              port: receiverStatus.port ?? "unknown",
            }}
          />
        </Typography>
      )}
      {receiverStatus.lastSenderDeviceId && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          <FormattedMessage
            defaultMessage="Last sender: {senderId}"
            values={{ senderId: receiverStatus.lastSenderDeviceId }}
          />
        </Typography>
      )}
      {receiverStatus.lastDeliveryStatus && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {lastDeliveryTimeLabel ? (
            <FormattedMessage
              defaultMessage="Last delivery: {status} at {timestamp}"
              values={{
                status: receiverStatus.lastDeliveryStatus,
                timestamp: lastDeliveryTimeLabel,
              }}
            />
          ) : (
            <FormattedMessage
              defaultMessage="Last delivery: {status}"
              values={{ status: receiverStatus.lastDeliveryStatus }}
            />
          )}
        </Typography>
      )}
      {receiverStatus.lastError && (
        <Typography
          variant="caption"
          sx={{
            color: "error.main",
            wordBreak: "break-word",
          }}
        >
          <FormattedMessage
            defaultMessage="Last error: {message}"
            values={{ message: receiverStatus.lastError }}
          />
        </Typography>
      )}
      <ReceiverTargetDetails receiverStatus={receiverStatus} />
    </Stack>
  );
};

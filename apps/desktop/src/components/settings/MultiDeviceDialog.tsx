import type { SelectChangeEvent } from "@mui/material";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type {
  PairedRemoteDevice,
  RemoteDevicePlatform,
  RemoteDeviceRole,
  RemoteReceiverStatus,
} from "@maus-inc/types";
import { ChangeEvent, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { sendRemoteTestOutput } from "../../actions/remote-output.actions";
import {
  buildRemotePairingInvite,
  pairWithRemoteInvite,
} from "../../actions/remote-pairing.actions";
import {
  deletePairedRemoteDevice,
  upsertPairedRemoteDevice,
} from "../../actions/paired-remote-device.actions";
import {
  startRemoteReceiver,
  refreshRemoteReceiverStatus,
  stopRemoteReceiver,
} from "../../actions/remote-receiver.actions";
import {
  setRemoteOutputEnabled,
  setRemoteReceiverAutoStart,
  setRemoteReceiverPort,
  setRemoteTargetDeviceId,
} from "../../actions/user.actions";
import {
  getRemoteReceiverStatus,
  listPairedRemoteDevices,
} from "../../utils/device.utils";
import { produceAppState, useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";
import { SettingSection } from "../common/SettingSection";

const ReceiverStatusDetails = ({
  receiverStatus,
  onCopyInvite,
  onImportInvite,
}: {
  receiverStatus: RemoteReceiverStatus;
  onCopyInvite: () => void;
  onImportInvite: () => void;
}) => {
  const lastDeliveryTimeLabel = receiverStatus.lastDeliveryAt
    ? new Date(receiverStatus.lastDeliveryAt).toLocaleString()
    : null;
  const lastTargetLooksLikeMausVoice =
    receiverStatus.lastTargetClassName === "Tauri Window";
  const lastTargetMissingEditableField =
    receiverStatus.lastTargetEditable === false &&
    receiverStatus.lastDeliveryStatus === "failed";

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
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        <FormattedMessage defaultMessage="Use Copy invite on the receiver machine, then Import invite on the sender machine. Manual trusted-device entry still works as a fallback." />
      </Typography>
      <Stack direction="row" spacing={1} sx={{ pt: 0.5 }}>
        <Button
          size="small"
          variant="outlined"
          onClick={onCopyInvite}
          disabled={!receiverStatus.enabled}
        >
          <FormattedMessage defaultMessage="Copy invite" />
        </Button>
        <Button size="small" variant="outlined" onClick={onImportInvite}>
          <FormattedMessage defaultMessage="Import invite" />
        </Button>
      </Stack>
    </Stack>
  );
};

const RemoteTargetDetails = ({
  selectedRemoteTarget,
}: {
  selectedRemoteTarget: PairedRemoteDevice;
}) => {
  return (
    <Stack spacing={0.5} sx={{ mt: -1 }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        <FormattedMessage
          defaultMessage="Active receiver: {name}"
          values={{ name: selectedRemoteTarget.name }}
        />
      </Typography>
      {selectedRemoteTarget.lastKnownAddress && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            wordBreak: "break-word",
          }}
        >
          <FormattedMessage
            defaultMessage="Receiver address: {address}"
            values={{ address: selectedRemoteTarget.lastKnownAddress }}
          />
        </Typography>
      )}
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        <FormattedMessage
          defaultMessage="Receiver device ID: {deviceId}"
          values={{ deviceId: selectedRemoteTarget.id }}
        />
      </Typography>
    </Stack>
  );
};

const PairDeviceDialog = ({
  open,
  editingDeviceId,
  pairName,
  pairDeviceId,
  pairAddress,
  pairSecret,
  pairPlatform,
  pairRole,
  addressLabel,
  addressHelperText,
  onChangeName,
  onChangeDeviceId,
  onChangeAddress,
  onChangeSecret,
  onChangePlatform,
  onChangeRole,
  onSave,
  onClose,
}: {
  open: boolean;
  editingDeviceId: string | null;
  pairName: string;
  pairDeviceId: string;
  pairAddress: string;
  pairSecret: string;
  pairPlatform: RemoteDevicePlatform;
  pairRole: RemoteDeviceRole;
  addressLabel: string;
  addressHelperText: string;
  onChangeName: (value: string) => void;
  onChangeDeviceId: (value: string) => void;
  onChangeAddress: (value: string) => void;
  onChangeSecret: (value: string) => void;
  onChangePlatform: (value: RemoteDevicePlatform) => void;
  onChangeRole: (value: RemoteDeviceRole) => void;
  onSave: () => void;
  onClose: () => void;
}) => {
  const intl = useIntl();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {editingDeviceId ? (
          <FormattedMessage defaultMessage="Edit trusted device" />
        ) : (
          <FormattedMessage defaultMessage="Add trusted device" />
        )}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <TextField
            label={intl.formatMessage({ defaultMessage: "Device name" })}
            value={pairName}
            onChange={(event) => onChangeName(event.target.value)}
            fullWidth
          />
          <TextField
            label={intl.formatMessage({ defaultMessage: "Device ID" })}
            value={pairDeviceId}
            onChange={(event) => onChangeDeviceId(event.target.value)}
            fullWidth
          />
          <Select<RemoteDeviceRole>
            size="small"
            value={pairRole}
            onChange={(event) =>
              onChangeRole(event.target.value as RemoteDeviceRole)
            }
            fullWidth
          >
            <MenuItem value="receiver">
              {intl.formatMessage({ defaultMessage: "Receiver device" })}
            </MenuItem>
            <MenuItem value="sender">
              {intl.formatMessage({ defaultMessage: "Sender device" })}
            </MenuItem>
          </Select>
          <Select<RemoteDevicePlatform>
            size="small"
            value={pairPlatform}
            onChange={(event) =>
              onChangePlatform(event.target.value as RemoteDevicePlatform)
            }
            fullWidth
          >
            <MenuItem value="windows">
              {intl.formatMessage({ defaultMessage: "Windows" })}
            </MenuItem>
            <MenuItem value="macos">
              {intl.formatMessage({ defaultMessage: "macOS" })}
            </MenuItem>
          </Select>
          <TextField
            label={addressLabel}
            helperText={addressHelperText}
            value={pairAddress}
            onChange={(event) => onChangeAddress(event.target.value)}
            fullWidth
          />
          <TextField
            label={intl.formatMessage({ defaultMessage: "Shared secret" })}
            helperText={intl.formatMessage({
              defaultMessage:
                "Use the same secret on both the sender and receiver device records.",
            })}
            value={pairSecret}
            onChange={(event) => onChangeSecret(event.target.value)}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button variant="contained" onClick={onSave}>
          <FormattedMessage defaultMessage="Save" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const ImportInviteDialog = ({
  open,
  inviteCodeDraft,
  pairingBusy,
  onChangeInviteCode,
  onImport,
  onClose,
}: {
  open: boolean;
  inviteCodeDraft: string;
  pairingBusy: boolean;
  onChangeInviteCode: (value: string) => void;
  onImport: () => void;
  onClose: () => void;
}) => {
  const intl = useIntl();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <FormattedMessage defaultMessage="Import pairing invite" />
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Paste the invite copied from the receiver machine. mausVoice will trust both devices automatically." />
          </Typography>
          <TextField
            label={intl.formatMessage({ defaultMessage: "Pairing invite" })}
            value={inviteCodeDraft}
            onChange={(event) => onChangeInviteCode(event.target.value)}
            multiline
            minRows={3}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pairingBusy}>
          <FormattedMessage defaultMessage="Cancel" />
        </Button>
        <Button
          variant="contained"
          onClick={onImport}
          disabled={!inviteCodeDraft.trim() || pairingBusy}
        >
          <FormattedMessage defaultMessage="Pair" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const useRemoteReceiverPolling = (open: boolean) => {
  useEffect(() => {
    if (!open) {
      return;
    }

    void refreshRemoteReceiverStatus().catch(() => undefined);
    const intervalId = window.setInterval(() => {
      void refreshRemoteReceiverStatus().catch(() => undefined);
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [open]);
};

type ReceiverSettings = {
  receiverBusy: boolean;
  receiverPortDraft: string;
  hasPendingReceiverPortChange: boolean;
  receiverSummary: string;
  handleToggleReceiver: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRemoteReceiverPortChange: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  handleApplyRemoteReceiverPort: () => Promise<void>;
  handleRemoteReceiverAutoStartChange: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  handleCopyInvite: () => Promise<void>;
};

const useReceiverSettings = ({
  open,
  receiverStatus,
  remoteReceiverPort,
}: {
  open: boolean;
  receiverStatus: RemoteReceiverStatus | null;
  remoteReceiverPort: number | null;
}): ReceiverSettings => {
  const intl = useIntl();
  const [receiverBusy, setReceiverBusy] = useState(false);
  const [receiverPortDraft, setReceiverPortDraft] = useState("");

  useEffect(() => {
    setReceiverPortDraft(
      remoteReceiverPort == null ? "" : String(remoteReceiverPort),
    );
  }, [remoteReceiverPort, open]);

  const handleToggleReceiver = async (event: ChangeEvent<HTMLInputElement>) => {
    if (receiverBusy) {
      return;
    }

    setReceiverBusy(true);
    try {
      if (event.target.checked) {
        await startRemoteReceiver(remoteReceiverPort);
      } else {
        await stopRemoteReceiver();
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setReceiverBusy(false);
    }
  };

  const handleRemoteReceiverPortChange = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    setReceiverPortDraft(event.target.value);
  };

  const handleApplyRemoteReceiverPort = async () => {
    const raw = receiverPortDraft.trim();
    const nextValue = raw === "" ? null : Number(raw);
    if (
      raw !== "" &&
      (nextValue == null || !Number.isInteger(nextValue) || nextValue <= 0)
    ) {
      showErrorSnackbar("Receiver port must be a positive integer.");
      return;
    }
    if (nextValue === (remoteReceiverPort ?? null)) {
      showSnackbar("Receiver port is already up to date.");
      return;
    }
    if (receiverBusy) {
      return;
    }

    setReceiverBusy(true);
    try {
      await setRemoteReceiverPort(nextValue);
      setReceiverPortDraft(nextValue == null ? "" : String(nextValue));
      if (receiverStatus?.enabled) {
        await stopRemoteReceiver();
        await startRemoteReceiver(nextValue);
        showSnackbar("Receiver port updated and receiver restarted.", {
          mode: "success",
        });
      } else {
        showSnackbar("Receiver port saved.", { mode: "success" });
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setReceiverBusy(false);
    }
  };

  const handleRemoteReceiverAutoStartChange = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    void setRemoteReceiverAutoStart(event.target.checked);
  };

  const handleCopyInvite = async () => {
    if (!receiverStatus) {
      return;
    }

    const invite = buildRemotePairingInvite(receiverStatus);
    if (!invite) {
      showErrorSnackbar(
        "Enable the multi-device receiver first so mausVoice can generate an invite.",
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(invite);
      showSnackbar("Multi-device pairing invite copied.", { mode: "success" });
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  const receiverSummary = receiverStatus?.enabled
    ? intl.formatMessage(
        {
          defaultMessage:
            "Listening on {address}:{port}. Invite code is ready.",
        },
        {
          address: receiverStatus.listenAddress ?? "0.0.0.0",
          port: receiverStatus.port ?? "unknown",
        },
      )
    : intl.formatMessage({
        defaultMessage:
          "Enable receiver mode so paired senders can deliver final transcript text locally.",
      });

  const hasPendingReceiverPortChange =
    receiverPortDraft.trim() !==
    (remoteReceiverPort == null ? "" : String(remoteReceiverPort));

  return {
    receiverBusy,
    receiverPortDraft,
    hasPendingReceiverPortChange,
    receiverSummary,
    handleToggleReceiver,
    handleRemoteReceiverPortChange,
    handleApplyRemoteReceiverPort,
    handleRemoteReceiverAutoStartChange,
    handleCopyInvite,
  };
};

type SenderSettings = {
  testBusy: boolean;
  remoteTargetSummary: string;
  selectedRemoteTarget: PairedRemoteDevice | null;
  receiverDevices: PairedRemoteDevice[];
  handleToggleRemoteOutput: (event: ChangeEvent<HTMLInputElement>) => void;
  handleRemoteTargetDeviceChange: (event: SelectChangeEvent<string>) => void;
  handleSendTest: () => Promise<void>;
};

const useSenderSettings = ({
  remoteTargetDeviceId,
  pairedDevices,
}: {
  remoteTargetDeviceId: string | null;
  pairedDevices: PairedRemoteDevice[];
}): SenderSettings => {
  const intl = useIntl();
  const [testBusy, setTestBusy] = useState(false);

  const handleToggleRemoteOutput = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    if (enabled && !remoteTargetDeviceId) {
      const firstReceiver =
        pairedDevices.find((device) => device.role === "receiver") ?? null;
      if (!firstReceiver) {
        showErrorSnackbar("Pair a receiver first.");
        return;
      }
      void setRemoteTargetDeviceId(firstReceiver.id);
    }
    void setRemoteOutputEnabled(enabled);
  };

  const handleRemoteTargetDeviceChange = (event: SelectChangeEvent<string>) => {
    const deviceId = event.target.value || null;
    void setRemoteTargetDeviceId(deviceId);
  };

  const handleSendTest = async () => {
    if (!remoteTargetDeviceId) {
      showErrorSnackbar("Select a paired receiver first.");
      return;
    }
    if (testBusy) {
      return;
    }

    setTestBusy(true);
    try {
      await sendRemoteTestOutput(remoteTargetDeviceId);
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setTestBusy(false);
    }
  };

  const remoteTargetSummary = pairedDevices.some(
    (device) => device.role === "receiver",
  )
    ? intl.formatMessage({
        defaultMessage:
          "Route finalized dictation to a paired desktop instead of inserting locally.",
      })
    : intl.formatMessage({
        defaultMessage:
          "No paired multi-device targets yet. Pair a receiver before enabling cross-device output.",
      });
  const selectedRemoteTarget =
    pairedDevices.find((device) => device.id === remoteTargetDeviceId) ?? null;
  const receiverDevices = pairedDevices.filter(
    (device) => device.role === "receiver",
  );

  return {
    testBusy,
    remoteTargetSummary,
    selectedRemoteTarget,
    receiverDevices,
    handleToggleRemoteOutput,
    handleRemoteTargetDeviceChange,
    handleSendTest,
  };
};

type PairDialogState = {
  pairDialogOpen: boolean;
  editingDeviceId: string | null;
  pairName: string;
  pairDeviceId: string;
  pairAddress: string;
  pairSecret: string;
  pairPlatform: RemoteDevicePlatform;
  pairRole: RemoteDeviceRole;
  addressLabel: string;
  addressHelperText: string;
  openPairDialog: (device?: PairedRemoteDevice) => void;
  closePairDialog: () => void;
  handleSaveManualPair: () => Promise<void>;
  setPairName: (value: string) => void;
  setPairDeviceId: (value: string) => void;
  setPairAddress: (value: string) => void;
  setPairSecret: (value: string) => void;
  setPairPlatform: (value: RemoteDevicePlatform) => void;
  setPairRole: (value: RemoteDeviceRole) => void;
};

const resetPairForm = (
  setEditingDeviceId: (value: string | null) => void,
  setPairName: (value: string) => void,
  setPairDeviceId: (value: string) => void,
  setPairAddress: (value: string) => void,
  setPairSecret: (value: string) => void,
  setPairPlatform: (value: RemoteDevicePlatform) => void,
  setPairRole: (value: RemoteDeviceRole) => void,
) => {
  setEditingDeviceId(null);
  setPairName("");
  setPairDeviceId("");
  setPairAddress("");
  setPairSecret("");
  setPairPlatform("windows");
  setPairRole("receiver");
};

const usePairDialogState = (
  pairedDevices: PairedRemoteDevice[],
): PairDialogState => {
  const intl = useIntl();
  const [pairDialogOpen, setPairDialogOpen] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [pairName, setPairName] = useState("");
  const [pairDeviceId, setPairDeviceId] = useState("");
  const [pairAddress, setPairAddress] = useState("");
  const [pairSecret, setPairSecret] = useState("");
  const [pairPlatform, setPairPlatform] =
    useState<RemoteDevicePlatform>("windows");
  const [pairRole, setPairRole] = useState<RemoteDeviceRole>("receiver");

  const openPairDialog = (device?: PairedRemoteDevice) => {
    if (device) {
      setEditingDeviceId(device.id);
      setPairName(device.name);
      setPairDeviceId(device.id);
      setPairAddress(device.lastKnownAddress ?? "");
      setPairSecret(device.sharedSecret);
      setPairPlatform(device.platform);
      setPairRole(device.role);
    } else {
      resetPairForm(
        setEditingDeviceId,
        setPairName,
        setPairDeviceId,
        setPairAddress,
        setPairSecret,
        setPairPlatform,
        setPairRole,
      );
    }
    setPairDialogOpen(true);
  };

  const closePairDialog = () => {
    setPairDialogOpen(false);
    resetPairForm(
      setEditingDeviceId,
      setPairName,
      setPairDeviceId,
      setPairAddress,
      setPairSecret,
      setPairPlatform,
      setPairRole,
    );
  };

  const handleSaveManualPair = async () => {
    const name = pairName.trim();
    const deviceId = pairDeviceId.trim();
    const address = pairAddress.trim();
    const secret = pairSecret.trim();
    const requiresAddress = pairRole === "receiver";

    if (!name || !deviceId || !secret || (requiresAddress && !address)) {
      showErrorSnackbar(
        requiresAddress
          ? "Name, device ID, receiver address, and shared secret are required."
          : "Name, device ID, and shared secret are required.",
      );
      return;
    }

    try {
      const existing = pairedDevices.find((device) => device.id === deviceId);
      await upsertPairedRemoteDevice({
        id: deviceId,
        name,
        platform: pairPlatform,
        role: pairRole,
        sharedSecret: secret,
        pairedAt: existing?.pairedAt ?? new Date().toISOString(),
        lastSeenAt: null,
        lastKnownAddress: requiresAddress ? address : null,
        trusted: true,
      });
      closePairDialog();
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  const addressLabel =
    pairRole === "sender"
      ? intl.formatMessage({ defaultMessage: "Sender address (optional)" })
      : intl.formatMessage({ defaultMessage: "Receiver address" });

  const addressHelperText =
    pairRole === "sender"
      ? intl.formatMessage({
          defaultMessage:
            "Optional for now. Only receiver targets need an address for delivery.",
        })
      : intl.formatMessage({
          defaultMessage: "Example: 192.168.1.25:43123",
        });

  return {
    pairDialogOpen,
    editingDeviceId,
    pairName,
    pairDeviceId,
    pairAddress,
    pairSecret,
    pairPlatform,
    pairRole,
    addressLabel,
    addressHelperText,
    openPairDialog,
    closePairDialog,
    handleSaveManualPair,
    setPairName,
    setPairDeviceId,
    setPairAddress,
    setPairSecret,
    setPairPlatform,
    setPairRole,
  };
};

type ImportInviteState = {
  importDialogOpen: boolean;
  inviteCodeDraft: string;
  pairingBusy: boolean;
  setImportDialogOpen: (open: boolean) => void;
  setInviteCodeDraft: (value: string) => void;
  handleImportInvite: () => Promise<void>;
  closeImportDialog: () => void;
};

const useImportInviteState = (): ImportInviteState => {
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [inviteCodeDraft, setInviteCodeDraft] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);

  const handleImportInvite = async () => {
    if (pairingBusy) {
      return;
    }

    setPairingBusy(true);
    try {
      const device = await pairWithRemoteInvite(inviteCodeDraft);
      showSnackbar(`Paired with ${device.name}.`, { mode: "success" });
      setImportDialogOpen(false);
      setInviteCodeDraft("");
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setPairingBusy(false);
    }
  };

  const closeImportDialog = () => {
    if (!pairingBusy) {
      setImportDialogOpen(false);
      setInviteCodeDraft("");
    }
  };

  return {
    importDialogOpen,
    inviteCodeDraft,
    pairingBusy,
    setImportDialogOpen,
    setInviteCodeDraft,
    handleImportInvite,
    closeImportDialog,
  };
};

const ReceiverSettingsSection = ({
  receiverStatus,
  receiverBusy,
  receiverPortDraft,
  hasPendingReceiverPortChange,
  remoteReceiverAutoStart,
  receiverSummary,
  onToggleReceiver,
  onPortChange,
  onApplyPort,
  onAutoStartChange,
  onCopyInvite,
  onImportInvite,
}: {
  receiverStatus: RemoteReceiverStatus | null;
  receiverBusy: boolean;
  receiverPortDraft: string;
  hasPendingReceiverPortChange: boolean;
  remoteReceiverAutoStart: boolean;
  receiverSummary: string;
  onToggleReceiver: (event: ChangeEvent<HTMLInputElement>) => void;
  onPortChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onApplyPort: () => void;
  onAutoStartChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCopyInvite: () => void;
  onImportInvite: () => void;
}) => {
  const intl = useIntl();

  return (
    <>
      <SettingSection
        title={
          <FormattedMessage defaultMessage="Receive transcript from another device" />
        }
        description={receiverSummary}
        action={
          <Switch
            edge="end"
            checked={receiverStatus?.enabled ?? false}
            disabled={receiverBusy}
            onChange={onToggleReceiver}
          />
        }
      />

      {(receiverStatus?.enabled ?? false) && (
        <>
          <SettingSection
            title={<FormattedMessage defaultMessage="Receiver port" />}
            description={
              <FormattedMessage defaultMessage="Leave blank to auto-assign a port, or set a fixed port and apply it immediately. If the receiver is running, mausVoice will restart it for you." />
            }
            action={
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                }}
              >
                <TextField
                  size="small"
                  value={receiverPortDraft}
                  onChange={onPortChange}
                  placeholder={intl.formatMessage({
                    defaultMessage: "Auto",
                  })}
                  sx={{ width: 120 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onApplyPort}
                  disabled={!hasPendingReceiverPortChange || receiverBusy}
                >
                  <FormattedMessage defaultMessage="Apply" />
                </Button>
              </Stack>
            }
          />

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Start receiver automatically" />
            }
            description={
              <FormattedMessage defaultMessage="When enabled, mausVoice will start the multi-device receiver automatically on launch using the saved receiver port." />
            }
            action={
              <Switch
                edge="end"
                checked={remoteReceiverAutoStart}
                onChange={onAutoStartChange}
              />
            }
          />

          {receiverStatus && (
            <ReceiverStatusDetails
              receiverStatus={receiverStatus}
              onCopyInvite={onCopyInvite}
              onImportInvite={onImportInvite}
            />
          )}
        </>
      )}
    </>
  );
};

const SenderSettingsSection = ({
  remoteOutputEnabled,
  remoteTargetSummary,
  receiverDevices,
  remoteTargetDeviceId,
  selectedRemoteTarget,
  testBusy,
  onToggleOutput,
  onTargetChange,
  onSendTest,
}: {
  remoteOutputEnabled: boolean;
  remoteTargetSummary: string;
  receiverDevices: PairedRemoteDevice[];
  remoteTargetDeviceId: string | null;
  selectedRemoteTarget: PairedRemoteDevice | null;
  testBusy: boolean;
  onToggleOutput: (event: ChangeEvent<HTMLInputElement>) => void;
  onTargetChange: (event: SelectChangeEvent<string>) => void;
  onSendTest: () => void;
}) => {
  const intl = useIntl();

  return (
    <>
      <SettingSection
        title={
          <FormattedMessage defaultMessage="Send transcript to another device" />
        }
        description={remoteTargetSummary}
        action={
          <Switch
            edge="end"
            checked={remoteOutputEnabled}
            onChange={onToggleOutput}
          />
        }
      />

      {remoteOutputEnabled && (
        <>
          <SettingSection
            title={<FormattedMessage defaultMessage="Active receiver" />}
            description={
              <FormattedMessage defaultMessage="Choose which paired desktop should receive finalized dictation when sender mode is enabled." />
            }
            action={
              <Select<string>
                size="small"
                value={remoteTargetDeviceId ?? ""}
                onChange={onTargetChange}
                sx={{ minWidth: 180 }}
              >
                <MenuItem value="" disabled>
                  {intl.formatMessage({
                    defaultMessage: "Select a paired receiver",
                  })}
                </MenuItem>
                {receiverDevices.map((device) => (
                  <MenuItem key={device.id} value={device.id}>
                    {device.name}
                  </MenuItem>
                ))}
              </Select>
            }
          />

          {selectedRemoteTarget && (
            <RemoteTargetDetails selectedRemoteTarget={selectedRemoteTarget} />
          )}

          <SettingSection
            title={<FormattedMessage defaultMessage="Transport test" />}
            description={
              <FormattedMessage defaultMessage="Send a fixed test message to the active receiver to verify transport without using dictation." />
            }
            action={
              <Button
                size="small"
                variant="outlined"
                onClick={onSendTest}
                disabled={!remoteTargetDeviceId || testBusy}
              >
                <FormattedMessage defaultMessage="Send test" />
              </Button>
            }
          />
        </>
      )}
    </>
  );
};

const TrustedDevicesSection = ({
  pairedDevices,
  onAddDevice,
  onEditDevice,
}: {
  pairedDevices: PairedRemoteDevice[];
  onAddDevice: () => void;
  onEditDevice: (device: PairedRemoteDevice) => void;
}) => {
  return (
    <>
      <SettingSection
        title={<FormattedMessage defaultMessage="Trusted devices" />}
        description={
          <FormattedMessage defaultMessage="Add a trusted device manually while invite pairing is available as the preferred path. Sender machines add receivers; receiver machines add senders." />
        }
        action={
          <Button size="small" variant="outlined" onClick={onAddDevice}>
            <FormattedMessage defaultMessage="Add device" />
          </Button>
        }
      />

      {pairedDevices.length > 0 && (
        <Stack spacing={1} sx={{ mt: -1 }}>
          {pairedDevices.map((device) => (
            <PairedDeviceRow
              key={device.id}
              device={device}
              onEdit={() => onEditDevice(device)}
            />
          ))}
        </Stack>
      )}
    </>
  );
};

export const MultiDeviceDialog = () => {
  const [
    open,
    remoteOutputEnabled,
    remoteTargetDeviceId,
    remoteReceiverPort,
    remoteReceiverAutoStart,
    pairedDevices,
    receiverStatus,
  ] = useAppStore((state) => {
    const prefs = getMyUserPreferences(state);
    return [
      state.settings.multiDeviceDialogOpen,
      prefs?.remoteOutputEnabled ?? false,
      prefs?.remoteTargetDeviceId ?? null,
      prefs?.remoteReceiverPort ?? null,
      prefs?.remoteReceiverAutoStart ?? false,
      listPairedRemoteDevices(state),
      getRemoteReceiverStatus(state),
    ] as const;
  });

  useRemoteReceiverPolling(open);

  const receiver = useReceiverSettings({
    open,
    receiverStatus,
    remoteReceiverPort,
  });
  const sender = useSenderSettings({
    remoteTargetDeviceId,
    pairedDevices,
  });
  const pair = usePairDialogState(pairedDevices);
  const invite = useImportInviteState();

  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.multiDeviceDialogOpen = false;
    });
  };

  return (
    <>
      <Dialog open={open} onClose={handleClose}>
        <DialogTitle>
          <FormattedMessage defaultMessage="Multi-device" />
        </DialogTitle>
        <DialogContent dividers sx={{ minWidth: 360 }}>
          <Stack spacing={3}>
            <ReceiverSettingsSection
              receiverStatus={receiverStatus}
              receiverBusy={receiver.receiverBusy}
              receiverPortDraft={receiver.receiverPortDraft}
              hasPendingReceiverPortChange={
                receiver.hasPendingReceiverPortChange
              }
              remoteReceiverAutoStart={remoteReceiverAutoStart}
              receiverSummary={receiver.receiverSummary}
              onToggleReceiver={receiver.handleToggleReceiver}
              onPortChange={receiver.handleRemoteReceiverPortChange}
              onApplyPort={receiver.handleApplyRemoteReceiverPort}
              onAutoStartChange={receiver.handleRemoteReceiverAutoStartChange}
              onCopyInvite={receiver.handleCopyInvite}
              onImportInvite={() => invite.setImportDialogOpen(true)}
            />
            <SenderSettingsSection
              remoteOutputEnabled={remoteOutputEnabled}
              remoteTargetSummary={sender.remoteTargetSummary}
              receiverDevices={sender.receiverDevices}
              remoteTargetDeviceId={remoteTargetDeviceId}
              selectedRemoteTarget={sender.selectedRemoteTarget}
              testBusy={sender.testBusy}
              onToggleOutput={sender.handleToggleRemoteOutput}
              onTargetChange={sender.handleRemoteTargetDeviceChange}
              onSendTest={() => void sender.handleSendTest()}
            />
            <TrustedDevicesSection
              pairedDevices={pairedDevices}
              onAddDevice={() => pair.openPairDialog()}
              onEditDevice={pair.openPairDialog}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>
            <FormattedMessage defaultMessage="Close" />
          </Button>
        </DialogActions>
      </Dialog>

      <PairDeviceDialog
        open={pair.pairDialogOpen}
        editingDeviceId={pair.editingDeviceId}
        pairName={pair.pairName}
        pairDeviceId={pair.pairDeviceId}
        pairAddress={pair.pairAddress}
        pairSecret={pair.pairSecret}
        pairPlatform={pair.pairPlatform}
        pairRole={pair.pairRole}
        addressLabel={pair.addressLabel}
        addressHelperText={pair.addressHelperText}
        onChangeName={pair.setPairName}
        onChangeDeviceId={pair.setPairDeviceId}
        onChangeAddress={pair.setPairAddress}
        onChangeSecret={pair.setPairSecret}
        onChangePlatform={pair.setPairPlatform}
        onChangeRole={pair.setPairRole}
        onSave={() => void pair.handleSaveManualPair()}
        onClose={pair.closePairDialog}
      />

      <ImportInviteDialog
        open={invite.importDialogOpen}
        inviteCodeDraft={invite.inviteCodeDraft}
        pairingBusy={invite.pairingBusy}
        onChangeInviteCode={invite.setInviteCodeDraft}
        onImport={() => void invite.handleImportInvite()}
        onClose={invite.closeImportDialog}
      />
    </>
  );
};

type PairedDeviceRowProps = {
  device: PairedRemoteDevice;
  onEdit: () => void;
};

const PairedDeviceRow = ({ device, onEdit }: PairedDeviceRowProps) => {
  const intl = useIntl();

  const handleCopy = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showSnackbar(successMessage, { mode: "success" });
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  const handleDelete = async () => {
    try {
      await deletePairedRemoteDevice(device.id);
      showSnackbar(
        intl.formatMessage({ defaultMessage: "Trusted device deleted" }),
        { mode: "success" },
      );
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  return (
    <Stack
      spacing={0.25}
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: 1,
        backgroundColor: "level1",
        minWidth: 0,
      }}
    >
      <Typography
        variant="body2"
        sx={{
          fontWeight: 600,
        }}
      >
        {device.name}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          wordBreak: "break-all",
        }}
      >
        <FormattedMessage
          defaultMessage="Device ID: {deviceId}"
          values={{ deviceId: device.id }}
        />
      </Typography>
      {device.lastKnownAddress && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            wordBreak: "break-all",
          }}
        >
          <FormattedMessage
            defaultMessage="Address: {address}"
            values={{ address: device.lastKnownAddress }}
          />
        </Typography>
      )}
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          wordBreak: "break-word",
        }}
      >
        <FormattedMessage
          defaultMessage="Role: {role} • Platform: {platform}"
          values={{ role: device.role, platform: device.platform }}
        />
      </Typography>
      <Stack
        direction="row"
        sx={{
          justifyContent: "flex-end",
          pt: 0.5,
          flexWrap: "wrap",
          gap: 0.5,
        }}
      >
        <Button
          size="small"
          onClick={() =>
            void handleCopy(
              device.id,
              intl.formatMessage({ defaultMessage: "Device ID copied" }),
            )
          }
        >
          <FormattedMessage defaultMessage="Copy ID" />
        </Button>
        {device.lastKnownAddress && (
          <Button
            size="small"
            onClick={() =>
              void handleCopy(
                device.lastKnownAddress ?? "",
                intl.formatMessage({
                  defaultMessage: "Receiver address copied",
                }),
              )
            }
          >
            <FormattedMessage defaultMessage="Copy address" />
          </Button>
        )}
        <Button
          size="small"
          onClick={() =>
            void handleCopy(
              device.sharedSecret,
              intl.formatMessage({ defaultMessage: "Shared secret copied" }),
            )
          }
        >
          <FormattedMessage defaultMessage="Copy secret" />
        </Button>
        <Button size="small" onClick={onEdit}>
          <FormattedMessage defaultMessage="Edit" />
        </Button>
        <Button size="small" color="error" onClick={() => void handleDelete()}>
          <FormattedMessage defaultMessage="Delete" />
        </Button>
      </Stack>
    </Stack>
  );
};

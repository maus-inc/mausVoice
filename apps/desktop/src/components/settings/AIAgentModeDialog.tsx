import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { ChangeEvent, useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import {
  getIsAssistantModeEnabled,
  getIsPowerModeEnabled,
} from "../../utils/assistant-mode.utils";
import { AGENT_DICTATE_HOTKEY } from "../../utils/keyboard.utils";
import { DialogTitleWithClose } from "../common/DialogTitleWithClose";
import { SettingSection } from "../common/SettingSection";
import { AIAgentModeConfiguration } from "./AIAgentModeConfiguration";
import { HotkeySetting } from "./HotkeySetting";

const ToggleRow = ({
  title,
  description,
  checked,
  onChange,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) => {
  return (
    <SettingSection
      title={title}
      description={description}
      action={<Switch checked={checked} onChange={onChange} />}
      sx={{
        alignItems: "flex-start",
        width: "100%",
      }}
    />
  );
};

export const AIAgentModeDialog = () => {
  const open = useAppStore((state) => state.settings.agentModeDialogOpen);
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);
  const powerModeEnabled = useAppStore(getIsPowerModeEnabled);
  const handleClose = () => {
    produceAppState((draft) => {
      draft.settings.agentModeDialogOpen = false;
    });
  };

  const handleAssistantModeToggle = (event: ChangeEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.local.assistantModeEnabled = event.target.checked;
    });
  };

  const [powerModeWarningOpen, setPowerModeWarningOpen] = useState(false);

  const handlePowerModeToggle = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setPowerModeWarningOpen(true);
    } else {
      produceAppState((draft) => {
        draft.local.powerModeEnabled = false;
      });
    }
  };

  const handleConfirmPowerMode = () => {
    produceAppState((draft) => {
      draft.local.powerModeEnabled = true;
    });
    setPowerModeWarningOpen(false);
  };

  return (
    <>
      <Dialog
        open={powerModeWarningOpen}
        onClose={() => setPowerModeWarningOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <WarningAmberRoundedIcon color="warning" />
          <FormattedMessage defaultMessage="Enable power mode?" />
        </DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            <FormattedMessage defaultMessage="Power mode allows the assistant to run terminal commands on your computer. This is powerful but inherently dangerous — commands run with your full user permissions and can modify files, install software, or access sensitive data." />
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 1.5,
            }}
          >
            <FormattedMessage defaultMessage="This feature is very experimental. Only enable this if you know what you're doing. You will still be asked to approve each command before it runs." />
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 1.5,
              fontWeight: 600,
            }}
          >
            <FormattedMessage defaultMessage="By enabling power mode, you accept full responsibility for any actions taken by the assistant. mausVoice is not liable for any consequences resulting from commands executed on your system." />
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPowerModeWarningOpen(false)}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            onClick={handleConfirmPowerMode}
            color="warning"
            variant="contained"
          >
            <FormattedMessage defaultMessage="I understand, enable power mode" />
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitleWithClose onClose={handleClose}>
          <FormattedMessage defaultMessage="Assistant mode" />
          <Chip label="Beta" size="small" color="primary" />
        </DialogTitleWithClose>
        <DialogContent dividers>
          <Stack
            spacing={3}
            sx={{
              alignItems: "flex-start",
            }}
          >
            <Typography
              variant="body1"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage defaultMessage="Assistant mode follows commands you dictate instead of just cleaning up text." />
            </Typography>

            <AIAgentModeConfiguration />
            <Divider flexItem />

            <HotkeySetting
              title={<FormattedMessage defaultMessage="Assistant hotkey" />}
              description={
                <FormattedMessage defaultMessage="Press this key combination to start assistant mode." />
              }
              actionName={AGENT_DICTATE_HOTKEY}
            />

            <Divider flexItem />

            <ToggleRow
              title={<FormattedMessage defaultMessage="Assistant mode" />}
              description={
                <FormattedMessage defaultMessage="Assistant mode is disabled by default. This is a new experimental feature." />
              }
              checked={assistantModeEnabled}
              onChange={handleAssistantModeToggle}
            />

            <ToggleRow
              title={<FormattedMessage defaultMessage="Power mode" />}
              description={
                <FormattedMessage defaultMessage="Allow the assistant to run terminal commands on your behalf. This is a temporary guardrail that will be removed in a future update. Restart mausVoice to apply changes." />
              }
              checked={powerModeEnabled}
              onChange={handlePowerModeToggle}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>
            <FormattedMessage defaultMessage="Done" />
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

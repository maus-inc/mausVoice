import {
  AppsOutlined,
  ArrowOutwardRounded,
  AutoAwesomeOutlined,
  AutoFixHighOutlined,
  DeleteForeverOutlined,
  DescriptionOutlined,
  Edit,
  GraphicEqOutlined,
  KeyboardAltOutlined,
  KeyOutlined,
  LanguageOutlined,
  MicOutlined,
  MoreVertOutlined,
  PrivacyTipOutlined,
  RocketLaunchOutlined,
  TroubleshootOutlined,
  VolumeUpOutlined,
  WarningAmberOutlined,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChangeEvent, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { showSnackbar } from "../../actions/app.actions";
import { savePersonalGroqApiKey } from "../../actions/personal-use.actions";
import { setAutoLaunchEnabled } from "../../actions/settings.actions";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import {
  getAllowsChangePostProcessing,
  getAllowsChangeTranscription,
} from "../../utils/enterprise.utils";
import { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
  WHISPER_LANGUAGES,
} from "../../utils/language.utils";
import {
  getDetectedSystemLocale,
  getGenerativePrefs,
  getMyUser,
} from "../../utils/user.utils";
import {
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
} from "../../utils/personal-use.utils";
import { ListTile } from "../common/ListTile";
import { Section } from "../common/Section";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";

export default function SettingsPage() {
  const isEnterprise = useAppStore((state) => state.isEnterprise);
  const allowChangeTranscription = useAppStore(getAllowsChangeTranscription);
  const allowChangePostProcessing = useAppStore(getAllowsChangePostProcessing);
  const [groqDialogOpen, setGroqDialogOpen] = useState(false);
  const [groqApiKeyInput, setGroqApiKeyInput] = useState("");
  const [groqSaving, setGroqSaving] = useState(false);
  const [groqError, setGroqError] = useState<string | null>(null);
  const personalGroqApiKey = useAppStore((state) =>
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.id === PERSONAL_GROQ_API_KEY_ID ||
        (apiKey.provider === "groq" &&
          apiKey.name.trim() === PERSONAL_GROQ_API_KEY_NAME),
    ),
  );
  const [autoLaunchEnabled, autoLaunchStatus] = useAppStore((state) => [
    state.settings.autoLaunchEnabled,
    state.settings.autoLaunchStatus,
  ]);
  const autoLaunchLoading = autoLaunchStatus === "loading";
  const intl = useIntl();

  const dictationLanguage = useAppStore((state) => {
    const user = getMyUser(state);
    return user?.preferredLanguage ?? getDetectedSystemLocale();
  });

  const dictationLanguageWarning = useAppStore((state) => {
    const hasPostProcessingEnabled = getGenerativePrefs(state).mode !== "none";
    if (hasPostProcessingEnabled) {
      return null;
    }

    if (dictationLanguage === KEYBOARD_LAYOUT_LANGUAGE) {
      return null;
    }

    const isWhisperLang = dictationLanguage in WHISPER_LANGUAGES;
    if (!isWhisperLang) {
      return intl.formatMessage({
        defaultMessage:
          "Be sure to enable AI post processing when using this language for the best results.",
      });
    }

    return null;
  });

  const hasAdditionalLanguages = useAppStore(
    (state) => getAdditionalLanguageEntries(state).length > 0,
  );

  const openDictationLanguageDialog = () => {
    produceAppState((draft) => {
      draft.settings.dictationLanguageDialogOpen = true;
    });
  };

  const handleDictationLanguageChange = (event: SelectChangeEvent<string>) => {
    const nextValue = event.target.value;
    void setPreferredLanguage(nextValue).then(() => {
      loadTones();
    });
  };

  const openTranscriptionDialog = () => {
    produceAppState((draft) => {
      draft.settings.aiTranscriptionDialogOpen = true;
    });
  };

  const openPostProcessingDialog = () => {
    produceAppState((draft) => {
      draft.settings.aiPostProcessingDialogOpen = true;
    });
  };

  const openAppKeybindingsDialog = () => {
    produceAppState((draft) => {
      draft.settings.appKeybindingsDialogOpen = true;
    });
  };

  const openAgentModeDialog = () => {
    produceAppState((draft) => {
      draft.settings.agentModeDialogOpen = true;
    });
  };

  const openGroqDialog = () => {
    setGroqApiKeyInput("");
    setGroqError(null);
    setGroqDialogOpen(true);
  };

  const closeGroqDialog = () => {
    if (!groqSaving) {
      setGroqDialogOpen(false);
    }
  };

  const handleSaveGroqApiKey = async () => {
    const trimmed = groqApiKeyInput.trim();
    if (!trimmed || groqSaving) {
      return;
    }

    setGroqSaving(true);
    setGroqError(null);
    try {
      await savePersonalGroqApiKey(trimmed);
      showSnackbar("Groq API key saved", { mode: "success" });
      setGroqApiKeyInput("");
      setGroqDialogOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save Groq API key.";
      setGroqError(message);
    } finally {
      setGroqSaving(false);
    }
  };

  const openMicrophoneDialog = () => {
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = true;
    });
  };

  const openAudioDialog = () => {
    produceAppState((draft) => {
      draft.settings.audioDialogOpen = true;
    });
  };

  const openDiagnosticsDialog = () => {
    produceAppState((draft) => {
      draft.settings.diagnosticsDialogOpen = true;
    });
  };

  const openShortcutsDialog = () => {
    produceAppState((draft) => {
      draft.settings.shortcutsDialogOpen = true;
    });
  };

  const openMoreSettingsDialog = () => {
    produceAppState((draft) => {
      draft.settings.moreSettingsDialogOpen = true;
    });
  };

  const openClearLocalDataDialog = () => {
    produceAppState((draft) => {
      draft.settings.clearLocalDataDialogOpen = true;
    });
  };

  const handleToggleAutoLaunch = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    void setAutoLaunchEnabled(enabled);
  };

  const general = (
    <Section title={<FormattedMessage defaultMessage="General" />}>
      <ListTile
        title={<FormattedMessage defaultMessage="Start on system startup" />}
        leading={<RocketLaunchOutlined />}
        disableRipple={true}
        trailing={
          <Switch
            edge="end"
            checked={autoLaunchEnabled}
            disabled={autoLaunchLoading}
            onChange={handleToggleAutoLaunch}
          />
        }
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Microphone" />}
        leading={<MicOutlined />}
        onClick={openMicrophoneDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Audio" />}
        leading={<VolumeUpOutlined />}
        onClick={openAudioDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Hotkey shortcuts" />}
        leading={<KeyboardAltOutlined />}
        onClick={openShortcutsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Diagnostics" />}
        leading={<TroubleshootOutlined />}
        onClick={openDiagnosticsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Text insertion options" />}
        leading={<AppsOutlined />}
        onClick={openAppKeybindingsDialog}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="More settings" />}
        leading={<MoreVertOutlined />}
        onClick={openMoreSettingsDialog}
      />
    </Section>
  );

  const dictationLanguageComp = (
    <>
      {hasAdditionalLanguages ? (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          onClick={openDictationLanguageDialog}
          trailing={
            <Button
              variant="outlined"
              size="small"
              endIcon={<Edit sx={{ fontSize: 16 }} />}
              onClick={openDictationLanguageDialog}
              sx={{ textTransform: "none", py: 0.5, px: 1.5, fontWeight: 400 }}
            >
              <FormattedMessage defaultMessage="Multiple languages" />
            </Button>
          }
        />
      ) : (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          disableRipple={true}
          trailing={
            <Box
              onClick={(event) => event.stopPropagation()}
              sx={{
                minWidth: 200,
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              {dictationLanguageWarning && (
                <Tooltip
                  title={
                    <Box>
                      {dictationLanguageWarning}{" "}
                      <Link
                        component="button"
                        color="inherit"
                        sx={{ verticalAlign: "baseline" }}
                        onClick={openPostProcessingDialog}
                      >
                        <FormattedMessage defaultMessage="Fix issue" />
                      </Link>
                    </Box>
                  }
                  slotProps={{
                    popper: {
                      modifiers: [
                        { name: "offset", options: { offset: [0, -8] } },
                      ],
                    },
                  }}
                >
                  <WarningAmberOutlined color="warning" fontSize="small" />
                </Tooltip>
              )}
              <Tooltip
                title={
                  <FormattedMessage defaultMessage="Set up multiple languages with different hotkeys" />
                }
              >
                <IconButton size="small" onClick={openDictationLanguageDialog}>
                  <MoreVertOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Select
                value={dictationLanguage}
                onChange={handleDictationLanguageChange}
                size="small"
                variant="outlined"
                fullWidth
                inputProps={{ "aria-label": "Dictation language" }}
                MenuProps={{
                  PaperProps: {
                    style: {
                      maxHeight: 300,
                    },
                  },
                }}
              >
                {DICTATION_LANGUAGE_OPTIONS.map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          }
        />
      )}
    </>
  );

  const processing = (
    <Section
      title={<FormattedMessage defaultMessage="Processing" />}
      description={
        <FormattedMessage defaultMessage="How Voquill should manage your transcriptions." />
      }
    >
      {dictationLanguageComp}
      <ListTile
        title={<FormattedMessage defaultMessage="Groq API key" />}
        subtitle={
          <FormattedMessage defaultMessage="Used for transcription and AI post processing." />
        }
        leading={<KeyOutlined />}
        onClick={openGroqDialog}
        trailing={
          <Chip
            size="small"
            color={personalGroqApiKey ? "success" : "default"}
            label={
              personalGroqApiKey ? (
                <FormattedMessage defaultMessage="Configured" />
              ) : (
                <FormattedMessage defaultMessage="Not configured" />
              )
            }
          />
        }
      />
      {allowChangeTranscription && (
        <ListTile
          title={<FormattedMessage defaultMessage="AI transcription" />}
          leading={<GraphicEqOutlined />}
          onClick={openTranscriptionDialog}
        />
      )}
      {allowChangePostProcessing && (
        <ListTile
          title={<FormattedMessage defaultMessage="AI post processing" />}
          leading={<AutoFixHighOutlined />}
          onClick={openPostProcessingDialog}
        />
      )}
      {!isEnterprise && (
        <ListTile
          title={
            <Stack direction="row" alignItems="center">
              <FormattedMessage defaultMessage="Assistant mode" />
              <Chip label="Beta" size="small" color="primary" sx={{ ml: 1 }} />
            </Stack>
          }
          leading={<AutoAwesomeOutlined />}
          onClick={openAgentModeDialog}
        />
      )}
    </Section>
  );

  const advanced = (
    <Section
      title={<FormattedMessage defaultMessage="Advanced" />}
      description={
        <FormattedMessage defaultMessage="Manage your account preferences and settings." />
      }
    >
      <ListTile
        title={<FormattedMessage defaultMessage="Terms & conditions" />}
        onClick={() => openUrl("https://voquill.com/terms")}
        trailing={<ArrowOutwardRounded />}
        leading={<DescriptionOutlined />}
      />
      <ListTile
        title={<FormattedMessage defaultMessage="Privacy policy" />}
        onClick={() => openUrl("https://voquill.com/privacy")}
        trailing={<ArrowOutwardRounded />}
        leading={<PrivacyTipOutlined />}
      />
    </Section>
  );

  const dangerZone = (
    <Section
      title={<FormattedMessage defaultMessage="Danger zone" />}
      description={
        <FormattedMessage defaultMessage="Be careful with these actions. They can have significant consequences for your account." />
      }
    >
      <ListTile
        title={<FormattedMessage defaultMessage="Clear local data" />}
        leading={<DeleteForeverOutlined />}
        onClick={openClearLocalDataDialog}
      />
    </Section>
  );

  return (
    <DashboardEntryLayout>
      <Stack direction="column">
        <Typography variant="h4" fontWeight={700} sx={{ marginBottom: 4 }}>
          <FormattedMessage defaultMessage="Settings" />
        </Typography>
        {general}
        {processing}
        {advanced}
        {!isEnterprise && dangerZone}
      </Stack>
      <Dialog
        open={groqDialogOpen}
        onClose={closeGroqDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          <FormattedMessage defaultMessage="Groq API key" />
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              <FormattedMessage defaultMessage="Store your Groq API key locally for transcription and AI post processing. The key is encrypted before it is saved." />
            </Typography>
            {personalGroqApiKey?.keySuffix && (
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage
                  defaultMessage="Current key ends with {suffix}."
                  values={{ suffix: personalGroqApiKey.keySuffix }}
                />
              </Typography>
            )}
            {groqError && <Alert severity="error">{groqError}</Alert>}
            <TextField
              autoFocus
              fullWidth
              size="small"
              type="password"
              label={<FormattedMessage defaultMessage="API key" />}
              placeholder={intl.formatMessage({ defaultMessage: "gsk_..." })}
              value={groqApiKeyInput}
              disabled={groqSaving}
              onChange={(event) => setGroqApiKeyInput(event.target.value)}
              autoComplete="off"
              slotProps={{
                inputLabel: { shrink: true },
                htmlInput: {
                  "data-voquill-ignore": "true",
                },
              }}
            />
            <Link
              component="button"
              variant="body2"
              onClick={() => openUrl("https://console.groq.com/keys")}
              sx={{ alignSelf: "flex-start" }}
            >
              <FormattedMessage defaultMessage="Open Groq API keys" />
            </Link>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeGroqDialog} disabled={groqSaving}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveGroqApiKey}
            disabled={!groqApiKeyInput.trim() || groqSaving}
          >
            {groqSaving ? (
              <FormattedMessage defaultMessage="Saving..." />
            ) : (
              <FormattedMessage defaultMessage="Save" />
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </DashboardEntryLayout>
  );
}

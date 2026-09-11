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
  RocketLaunchOutlined,
  SearchRounded,
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
  InputAdornment,
  Link,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type {
  DictationPillVisibility,
  PillResetMonitorStrategy,
  StylingMode,
} from "@maus-inc/types";
import { commands, NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useSearchParams } from "react-router-dom";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  savePersonalDeepgramApiKey,
  savePersonalGroqApiKey,
} from "../../actions/personal-use.actions";
import { setAutoLaunchEnabled } from "../../actions/settings.actions";
import { SettingSection } from "../common/SettingSection";
import { TipCard } from "../onboarding/TipCard";
import { loadTones } from "../../actions/tone.actions";
import {
  setAlwaysRequestAdminOnStartup,
  setAutoLearnDictionaryEnabled,
  setAutoLearnFromEditsEnabled,
  setDictationLimitMinutes,
  setDictationPillVisibility,
  setHallucinationFilterEnabled,
  setHandsFreeDelayMs,
  setIgnoreUpdateDialog,
  setInDictationStyleSwitchingEnabled,
  setIncognitoModeEnabled,
  setIncognitoModeIncludeInStats,
  setMenuBarIconHidden,
  setPillResetMonitorStrategy,
  setPreferredLanguage,
  setRealtimeOutputEnabled,
  setReviewBeforeInsert,
  setSpokenCommandsEnabled,
  setStylingMode,
} from "../../actions/user.actions";
import { logOnRejection } from "../../utils/promise.utils";
import { isMacOS, isWindows } from "../../utils/env.utils";
import {
  getEffectiveDictationLimitMinutes,
  MAX_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import {
  getEffectiveHandsFreeDelayMs,
  MAX_HANDS_FREE_DELAY_MS,
} from "../../utils/hands-free-delay.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  getDetectedSystemLocale,
  getEffectivePillVisibility,
  getGenerativePrefs,
  getMyUser,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { PillPlacementSetting } from "./PillPlacementSetting";
import { UpdateChannelSetting } from "./UpdateChannelSetting";
import { UpdateSettingSection } from "./UpdateSettingSection";
import { SegmentedControl } from "../common/SegmentedControl";
import { searchSettings, SETTING_ENTRIES } from "../../utils/settings-registry";
import { produceAppState, useAppStore } from "../../store";
import { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
  WHISPER_LANGUAGES,
} from "../../utils/language.utils";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_API_KEY_NAME,
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
} from "../../utils/personal-use.utils";
import { ListTile } from "../common/ListTile";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Section } from "../common/Section";
import { DashboardEntryLayout } from "../dashboard/DashboardEntryLayout";
import { getPlatform } from "../../utils/platform.utils";

/**
 * Stable anchor around one setting row. Module-level so its identity never
 * changes across renders: an inline wrapper would remount the row (and drop
 * text-field focus) on every keystroke elsewhere on the page.
 */
const SettingAnchor = ({
  settingKey,
  highlight,
  children,
}: {
  settingKey: string;
  highlight: string | null;
  children: ReactNode;
}) => (
  <Box
    id={`setting-${settingKey}`}
    sx={
      highlight === settingKey
        ? {
            outline: 2,
            outlineColor: "primary.main",
            borderRadius: 1,
          }
        : undefined
    }
  >
    {children}
  </Box>
);

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const focusSetting = useCallback((key: string) => {
    setQuery("");
    setHighlight(key);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => setHighlight(null), 2400);
    requestAnimationFrame(() => {
      document
        .getElementById(`setting-${key}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  // Deep links (`settings?section=<id>&setting=<id>`) from tips, error
  // recovery, and update prompts. A setting link scrolls to the row and
  // highlights it; a bare section link scrolls to the section.
  useEffect(() => {
    const setting = searchParams.get("setting");
    if (setting && SETTING_ENTRIES.some((entry) => entry.key === setting)) {
      focusSetting(setting);
      return;
    }
    const section = searchParams.get("section");
    if (section) {
      requestAnimationFrame(() => {
        document
          .getElementById(`section-${section}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [searchParams, focusSetting]);

  const results = searchSettings(query);
  const [groqDialogOpen, setGroqDialogOpen] = useState(false);
  const [groqApiKeyInput, setGroqApiKeyInput] = useState("");
  const [groqSaving, setGroqSaving] = useState(false);
  const [groqError, setGroqError] = useState<string | null>(null);

  const [setupConfirmOpen, setSetupConfirmOpen] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);

  const runNativeSetup = async () => {
    setSetupConfirmOpen(false);
    setSetupRunning(true);
    try {
      const result: NativeSetupResult = await commands.runNativeSetup();
      if (result === "success") {
        showSnackbar("Input permissions configured.");
      } else if (result === "require-restart") {
        showSnackbar(
          "Setup complete. Please restart the app to apply input permissions.",
        );
      } else if (result === "cancelled") {
        // User dismissed the elevation prompt; stay quiet.
      } else {
        showErrorSnackbar("Failed to configure input permissions.");
      }
    } catch (err) {
      showErrorSnackbar(err);
    } finally {
      setSetupRunning(false);
    }
  };
  const personalGroqApiKey = useAppStore((state) =>
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.id === PERSONAL_GROQ_API_KEY_ID ||
        (apiKey.provider === "groq" &&
          apiKey.name.trim() === PERSONAL_GROQ_API_KEY_NAME),
    ),
  );
  const [deepgramDialogOpen, setDeepgramDialogOpen] = useState(false);
  const [deepgramApiKeyInput, setDeepgramApiKeyInput] = useState("");
  const [deepgramSaving, setDeepgramSaving] = useState(false);
  const [deepgramError, setDeepgramError] = useState<string | null>(null);
  const personalDeepgramApiKey = useAppStore((state) =>
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.id === PERSONAL_DEEPGRAM_API_KEY_ID ||
        (apiKey.provider === "deepgram" &&
          apiKey.name.trim() === PERSONAL_DEEPGRAM_API_KEY_NAME),
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

  const openDeepgramDialog = () => {
    setDeepgramApiKeyInput("");
    setDeepgramError(null);
    setDeepgramDialogOpen(true);
  };

  const closeDeepgramDialog = () => {
    if (!deepgramSaving) {
      setDeepgramDialogOpen(false);
    }
  };

  const handleSaveDeepgramApiKey = async () => {
    const trimmed = deepgramApiKeyInput.trim();
    if (!trimmed || deepgramSaving) {
      return;
    }

    setDeepgramSaving(true);
    setDeepgramError(null);
    try {
      await savePersonalDeepgramApiKey(trimmed);
      showSnackbar("Deepgram API key saved", { mode: "success" });
      setDeepgramApiKeyInput("");
      setDeepgramDialogOpen(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save Deepgram API key.";
      setDeepgramError(message);
    } finally {
      setDeepgramSaving(false);
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

  const openStyleHotkeysDialog = () => {
    produceAppState((draft) => {
      draft.settings.styleHotkeysDialogOpen = true;
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

  const [
    ignoreUpdateDialog,
    incognitoModeEnabled,
    incognitoIncludeInStats,
    dictationPillVisibility,
    pillResetMonitorStrategy,
    realtimeOutputEnabled,
    stylingMode,
    canChangeStylingMode,
    showDictationLimitSetting,
    dictationLimitMinutes,
    disablePillRewards,
    disableAutoStyleLoading,
    menuBarIconHidden,
    handsFreeDelayMs,
    autoLearnDictionaryEnabled,
    autoLearnFromEditsEnabled,
    spokenCommandsEnabled,
    reviewBeforeInsert,
    hallucinationFilterEnabled,
    inDictationStyleSwitchingEnabled,
  ] = useAppStore((state) => {
    const prefs = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    return [
      prefs?.ignoreUpdateDialog ?? false,
      prefs?.incognitoModeEnabled ?? false,
      prefs?.incognitoModeIncludeInStats ?? false,
      getEffectivePillVisibility(prefs?.dictationPillVisibility),
      prefs?.pillResetMonitorStrategy ?? "current",
      prefs?.realtimeOutputEnabled ?? false,
      getEffectiveStylingMode(state),
      true,
      shouldEnableDictationLimit(transcriptionPrefs.mode),
      getEffectiveDictationLimitMinutes(prefs),
      state.local.disablePillRewards,
      state.local.disableAutoStyleLoading ?? false,
      prefs?.menuBarIconHidden ?? false,
      getEffectiveHandsFreeDelayMs(prefs),
      prefs?.autoLearnDictionaryEnabled ?? true,
      prefs?.autoLearnFromEditsEnabled ?? false,
      prefs?.spokenCommandsEnabled ?? true,
      prefs?.reviewBeforeInsert ?? false,
      prefs?.hallucinationFilterEnabled ?? true,
      prefs?.inDictationStyleSwitchingEnabled ?? false,
    ] as const;
  });
  const [dictationLimitInput, setDictationLimitInput] = useState(
    String(dictationLimitMinutes),
  );
  const lastCommittedDictationLimitMinutesRef = useRef(dictationLimitMinutes);
  const [handsFreeDelayInput, setHandsFreeDelayInput] = useState(
    String(handsFreeDelayMs),
  );
  const lastCommittedHandsFreeDelayMsRef = useRef(handsFreeDelayMs);

  useEffect(() => {
    lastCommittedDictationLimitMinutesRef.current = dictationLimitMinutes;
    setDictationLimitInput(String(dictationLimitMinutes));
  }, [dictationLimitMinutes]);

  useEffect(() => {
    lastCommittedHandsFreeDelayMsRef.current = handsFreeDelayMs;
    setHandsFreeDelayInput(String(handsFreeDelayMs));
  }, [handsFreeDelayMs]);

  const commitDictationLimitInput = () => {
    if (!showDictationLimitSetting) {
      return;
    }

    if (dictationLimitInput === "") {
      setDictationLimitInput(String(dictationLimitMinutes));
      return;
    }

    const parsed = Number(dictationLimitInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDictationLimitInput(String(dictationLimitMinutes));
      return;
    }

    const normalized = normalizeDictationLimitMinutes(parsed);
    setDictationLimitInput(String(normalized));
    if (normalized === lastCommittedDictationLimitMinutesRef.current) {
      return;
    }

    lastCommittedDictationLimitMinutesRef.current = normalized;
    logOnRejection(
      setDictationLimitMinutes(normalized),
      "settings page: setDictationLimitMinutes",
    );
  };

  const handleToggleShowUpdates = (event: ChangeEvent<HTMLInputElement>) => {
    const showUpdates = event.target.checked;
    logOnRejection(
      setIgnoreUpdateDialog(!showUpdates),
      "settings page: setIgnoreUpdateDialog",
    );
  };

  const handleToggleIncognitoMode = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    logOnRejection(
      setIncognitoModeEnabled(enabled),
      "settings page: setIncognitoModeEnabled",
    );
  };

  const handleToggleIncognitoIncludeInStats = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const enabled = event.target.checked;
    logOnRejection(
      setIncognitoModeIncludeInStats(enabled),
      "settings page: setIncognitoModeIncludeInStats",
    );
  };

  const handleDictationPillVisibilityChange = (
    event: SelectChangeEvent<DictationPillVisibility>,
  ) => {
    const visibility = event.target.value as DictationPillVisibility;
    logOnRejection(
      setDictationPillVisibility(visibility),
      "settings page: setDictationPillVisibility",
    );
  };

  const handlePillResetMonitorStrategyChange = (
    strategy: PillResetMonitorStrategy,
  ) => {
    logOnRejection(
      setPillResetMonitorStrategy(strategy),
      "settings page: setPillResetMonitorStrategy",
    );
  };

  const handleToggleRealtimeOutput = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setRealtimeOutputEnabled(event.target.checked),
      "settings page: setRealtimeOutputEnabled",
    );
  };

  const handleToggleSpokenCommands = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setSpokenCommandsEnabled(event.target.checked),
      "settings page: setSpokenCommandsEnabled",
    );
  };

  const handleToggleReviewBeforeInsert = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setReviewBeforeInsert(event.target.checked),
      "settings page: setReviewBeforeInsert",
    );
  };

  const handleToggleHallucinationFilter = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setHallucinationFilterEnabled(event.target.checked),
      "settings page: setHallucinationFilterEnabled",
    );
  };

  const handleToggleInDictationStyleSwitching = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setInDictationStyleSwitchingEnabled(event.target.checked),
      "settings page: setInDictationStyleSwitchingEnabled",
    );
  };

  const handleToggleAutoLearnDictionary = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setAutoLearnDictionaryEnabled(event.target.checked),
      "settings page: setAutoLearnDictionaryEnabled",
    );
  };

  const handleToggleAutoLearnFromEdits = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setAutoLearnFromEditsEnabled(event.target.checked),
      "settings page: setAutoLearnFromEditsEnabled",
    );
  };

  const handleToggleDisablePillRewards = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disablePillRewards = !event.target.checked;
    });
  };

  const handleToggleMenuBarIcon = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setMenuBarIconHidden(!event.target.checked),
      "settings page: setMenuBarIconHidden",
    );
  };

  const handleToggleAutoStyleLoading = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disableAutoStyleLoading = !event.target.checked;
    });
  };

  const commitHandsFreeDelayInput = () => {
    if (handsFreeDelayInput === "") {
      setHandsFreeDelayInput(String(handsFreeDelayMs));
      return;
    }

    const parsed = Number(handsFreeDelayInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setHandsFreeDelayInput(String(handsFreeDelayMs));
      return;
    }

    const normalized = Math.min(
      MAX_HANDS_FREE_DELAY_MS,
      Math.max(0, Math.floor(parsed)),
    );
    setHandsFreeDelayInput(String(normalized));
    if (normalized === lastCommittedHandsFreeDelayMsRef.current) {
      return;
    }

    lastCommittedHandsFreeDelayMsRef.current = normalized;
    logOnRejection(
      setHandsFreeDelayMs(normalized),
      "settings page: setHandsFreeDelayMs",
    );
  };

  const handleHandsFreeDelayChange = (event: ChangeEvent<HTMLInputElement>) => {
    setHandsFreeDelayInput(event.target.value);
  };

  const handleHandsFreeDelayBlur = () => {
    commitHandsFreeDelayInput();
  };

  const handleDictationLimitChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setDictationLimitInput(value);
  };

  const handleDictationLimitBlur = () => {
    commitDictationLimitInput();
  };

  const allowMultiDevice = true;

  const handleStylingModeChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    logOnRejection(
      setStylingMode(value === "" ? null : (value as StylingMode)),
      "settings page: setStylingMode",
    );
  };

  const openMultiDeviceDialog = () => {
    produceAppState((draft) => {
      draft.settings.multiDeviceDialogOpen = true;
    });
  };

  const general = (
    <Section title={<FormattedMessage defaultMessage="General" />}>
      <SettingAnchor settingKey="start_on_system_startup" highlight={highlight}>
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
      </SettingAnchor>
      <SettingAnchor settingKey="microphone" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Microphone" />}
          leading={<MicOutlined />}
          onClick={openMicrophoneDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="audio" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Audio" />}
          leading={<VolumeUpOutlined />}
          onClick={openAudioDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="diagnostics" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Diagnostics" />}
          leading={<TroubleshootOutlined />}
          onClick={openDiagnosticsDialog}
        />
      </SettingAnchor>
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
                  slotProps: {
                    paper: {
                      style: {
                        maxHeight: 300,
                      },
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

  const dictation = (
    <Section title={<FormattedMessage defaultMessage="Dictation" />}>
      <SettingAnchor settingKey="dictation_language" highlight={highlight}>
        {dictationLanguageComp}
      </SettingAnchor>
      <SettingAnchor settingKey="text_insertion_options" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Text insertion options" />}
          leading={<AppsOutlined />}
          onClick={openAppKeybindingsDialog}
        />
      </SettingAnchor>
      {showDictationLimitSetting && (
        <SettingAnchor
          settingKey="dictation_limit_minutes"
          highlight={highlight}
        >
          <SettingSection
            title={
              <FormattedMessage defaultMessage="Dictation limit (minutes)" />
            }
            description={
              <FormattedMessage defaultMessage="Set the maximum dictation length in minutes. Enter 0 for no limit." />
            }
            action={
              <TextField
                size="small"
                type="number"
                value={dictationLimitInput}
                onChange={handleDictationLimitChange}
                onBlur={handleDictationLimitBlur}
                sx={{ width: 104 }}
                slotProps={{
                  htmlInput: {
                    min: 0,
                    max: MAX_DICTATION_LIMIT_MINUTES,
                    step: 1,
                    inputMode: "numeric",
                  },
                }}
              />
            }
          />
        </SettingAnchor>
      )}
      <SettingAnchor
        settingKey="hands_free_output_delay_ms"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Hands-free output delay (ms)" />
          }
          description={
            <FormattedMessage defaultMessage="Wait this many milliseconds before inserting the dictated text when you stop recording. Enter 0 to disable." />
          }
          action={
            <TextField
              size="small"
              type="number"
              value={handsFreeDelayInput}
              onChange={handleHandsFreeDelayChange}
              onBlur={handleHandsFreeDelayBlur}
              sx={{ width: 104 }}
              slotProps={{
                htmlInput: {
                  min: 0,
                  max: MAX_HANDS_FREE_DELAY_MS,
                  step: 50,
                  inputMode: "numeric",
                },
              }}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="spoken_commands" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Spoken commands" />}
          description={
            <FormattedMessage defaultMessage='Turn phrases like "new line", "comma", and "scratch that" into formatting, even in Verbatim. Requires an English dictation language; Auto does not apply these commands.' />
          }
          action={
            <Switch
              edge="end"
              checked={spokenCommandsEnabled}
              onChange={handleToggleSpokenCommands}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="real_time_output" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Real-time output" />}
          description={
            <FormattedMessage defaultMessage="Stream dictation text as you speak instead of pasting all at once when you stop. Only applies to Verbatim mode with supported providers." />
          }
          action={
            <Switch
              edge="end"
              checked={realtimeOutputEnabled}
              onChange={handleToggleRealtimeOutput}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="review_before_insert" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Review before insert" />}
          description={
            <FormattedMessage defaultMessage="Open an editable composer so you can review or change dictated text before it is inserted. Review pauses streaming, so turning this on turns Real-time output off." />
          }
          action={
            <Switch
              edge="end"
              checked={reviewBeforeInsert}
              onChange={handleToggleReviewBeforeInsert}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor
        settingKey="silence_hallucination_filter"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Silence hallucination filter" />
          }
          description={
            <FormattedMessage defaultMessage="Discard common fabricated phrases produced when the microphone hears silence or noise." />
          }
          action={
            <Switch
              edge="end"
              checked={hallucinationFilterEnabled}
              onChange={handleToggleHallucinationFilter}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor
        settingKey="switch_style_while_dictating"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Switch style while dictating" />
          }
          description={
            <FormattedMessage defaultMessage="Hold the dictate activation key and press Left or Right Arrow to cycle active styles." />
          }
          action={
            <Switch
              edge="end"
              checked={inDictationStyleSwitchingEnabled}
              onChange={handleToggleInDictationStyleSwitching}
            />
          }
        />
      </SettingAnchor>
    </Section>
  );

  const processing = (
    <Section
      title={<FormattedMessage defaultMessage="AI and processing" />}
      description={
        <FormattedMessage defaultMessage="How mausVoice should manage your transcriptions." />
      }
    >
      <TipCard id="generative-provider" />
      <SettingAnchor settingKey="deepgram_api_key" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Deepgram API key" />}
          subtitle={
            <FormattedMessage defaultMessage="Used for fast streaming transcription." />
          }
          leading={<KeyOutlined />}
          onClick={openDeepgramDialog}
          trailing={
            <Chip
              size="small"
              color={personalDeepgramApiKey ? "success" : "default"}
              label={
                personalDeepgramApiKey ? (
                  <FormattedMessage defaultMessage="Configured" />
                ) : (
                  <FormattedMessage defaultMessage="Not configured" />
                )
              }
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="groq_api_key" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Groq API key" />}
          subtitle={
            <FormattedMessage defaultMessage="Used for AI post processing." />
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
      </SettingAnchor>
      <SettingAnchor settingKey="ai_transcription" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="AI transcription" />}
          leading={<GraphicEqOutlined />}
          onClick={openTranscriptionDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="ai_post_processing" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="AI post processing" />}
          leading={<AutoFixHighOutlined />}
          onClick={openPostProcessingDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="assistant_mode" highlight={highlight}>
        <ListTile
          title={
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
              }}
            >
              <FormattedMessage defaultMessage="Assistant mode" />
              <Chip label="Beta" size="small" color="primary" sx={{ ml: 1 }} />
            </Stack>
          }
          leading={<AutoAwesomeOutlined />}
          onClick={openAgentModeDialog}
        />
      </SettingAnchor>
      {stylingMode === "manual" && (
        <SettingAnchor
          settingKey="automatic_style_loading"
          highlight={highlight}
        >
          <SettingSection
            title={
              <FormattedMessage defaultMessage="Automatic style loading" />
            }
            description={
              <FormattedMessage defaultMessage="Automatically load the manual style configured for the current app when starting dictation." />
            }
            action={
              <Switch
                edge="end"
                checked={!disableAutoStyleLoading}
                onChange={handleToggleAutoStyleLoading}
              />
            }
          />
        </SettingAnchor>
      )}
      {canChangeStylingMode && (
        <SettingAnchor settingKey="styling_mode" highlight={highlight}>
          <SettingSection
            title={<FormattedMessage defaultMessage="Styling mode" />}
            description={
              <FormattedMessage defaultMessage="Choose how to switch between writing styles." />
            }
            action={
              <Select<string>
                size="small"
                value={stylingMode}
                onChange={handleStylingModeChange}
                sx={{ minWidth: 152 }}
              >
                <MenuItem value="app">
                  {intl.formatMessage({ defaultMessage: "Based on app" })}
                </MenuItem>
                <MenuItem value="manual">
                  {intl.formatMessage({ defaultMessage: "Manual" })}
                </MenuItem>
              </Select>
            }
          />
        </SettingAnchor>
      )}
    </Section>
  );

  const pillAppearance = (
    <Section title={<FormattedMessage defaultMessage="Pill and appearance" />}>
      <SettingAnchor settingKey="show_menu_bar_icon" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Show menu bar icon" />}
          description={
            <FormattedMessage defaultMessage="Show the mausVoice icon in the menu bar." />
          }
          action={
            <Switch
              edge="end"
              checked={!menuBarIconHidden}
              onChange={handleToggleMenuBarIcon}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor
        settingKey="dictation_pill_visibility"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Dictation pill visibility" />
          }
          description={
            <FormattedMessage defaultMessage="Control when the dictation pill is shown on screen." />
          }
          action={
            <Select<DictationPillVisibility>
              size="small"
              value={dictationPillVisibility}
              onChange={handleDictationPillVisibilityChange}
              sx={{ minWidth: 152 }}
            >
              <MenuItem value="persistent">
                {intl.formatMessage({ defaultMessage: "Persistent" })}
              </MenuItem>
              <MenuItem value="while_active">
                {intl.formatMessage({ defaultMessage: "While active" })}
              </MenuItem>
              <MenuItem value="hidden">
                {intl.formatMessage({ defaultMessage: "Hidden" })}
              </MenuItem>
            </Select>
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="pill_placement" highlight={highlight}>
        <PillPlacementSetting />
      </SettingAnchor>
      <SettingAnchor settingKey="reset_pill_position" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Reset pill position" />}
          description={
            <FormattedMessage defaultMessage="Choose which monitor the pill returns to when you reset its position: the monitor the pill is on, or the monitor your mouse is on." />
          }
          action={
            <SegmentedControl<PillResetMonitorStrategy>
              value={pillResetMonitorStrategy}
              onChange={handlePillResetMonitorStrategyChange}
              options={[
                { value: "current", label: "Current monitor" },
                { value: "cursor", label: "Cursor monitor" },
              ]}
              ariaLabel="Reset pill position monitor"
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="streak_celebrations" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Streak celebrations" />}
          description={
            <FormattedMessage defaultMessage="Show flame and firework animations on the dictation pill for streak milestones." />
          }
          action={
            <Switch
              edge="end"
              checked={!disablePillRewards}
              onChange={handleToggleDisablePillRewards}
            />
          }
        />
      </SettingAnchor>
    </Section>
  );

  const shortcuts = (
    <Section title={<FormattedMessage defaultMessage="Shortcuts" />}>
      <SettingAnchor settingKey="hotkey_shortcuts" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Hotkey shortcuts" />}
          leading={<KeyboardAltOutlined />}
          onClick={openShortcutsDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="style_hotkeys" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Style hotkeys" />}
          leading={<KeyOutlined />}
          onClick={openStyleHotkeysDialog}
        />
      </SettingAnchor>
    </Section>
  );

  const privacyData = (
    <Section title={<FormattedMessage defaultMessage="Privacy and data" />}>
      <SettingAnchor settingKey="incognito_mode" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Incognito mode" />}
          description={
            <FormattedMessage defaultMessage="When enabled, mausVoice will not save transcription history or audio snapshots." />
          }
          action={
            <Switch
              edge="end"
              checked={incognitoModeEnabled}
              onChange={handleToggleIncognitoMode}
            />
          }
        />
      </SettingAnchor>
      {incognitoModeEnabled && (
        <SettingAnchor
          settingKey="include_incognito_in_stats"
          highlight={highlight}
        >
          <SettingSection
            title={
              <FormattedMessage defaultMessage="Include incognito in stats" />
            }
            description={
              <FormattedMessage defaultMessage="If enabled, words dictated in incognito mode will still count toward your usage statistics." />
            }
            action={
              <Switch
                edge="end"
                checked={incognitoIncludeInStats}
                onChange={handleToggleIncognitoIncludeInStats}
              />
            }
          />
        </SettingAnchor>
      )}
      <SettingAnchor settingKey="auto_learn_dictionary" highlight={highlight}>
        <SettingSection
          title={<FormattedMessage defaultMessage="Auto-learn dictionary" />}
          description={
            <FormattedMessage defaultMessage="When you correct a transcription, add the corrected names and words to your dictionary automatically." />
          }
          action={
            <Switch
              edge="end"
              checked={autoLearnDictionaryEnabled}
              onChange={handleToggleAutoLearnDictionary}
            />
          }
        />
      </SettingAnchor>
      {(isMacOS() || isWindows()) && (
        <SettingAnchor
          settingKey="learn_from_corrections"
          highlight={highlight}
        >
          <SettingSection
            title={<FormattedMessage defaultMessage="Learn from corrections" />}
            description={
              <FormattedMessage defaultMessage="After dictation, watch for corrections you make in the target app and offer to add the corrected names to your dictionary." />
            }
            action={
              <Switch
                edge="end"
                checked={autoLearnFromEditsEnabled}
                onChange={handleToggleAutoLearnFromEdits}
              />
            }
          />
        </SettingAnchor>
      )}
      {allowMultiDevice && (
        <SettingAnchor settingKey="multi_device" highlight={highlight}>
          <SettingSection
            title={<FormattedMessage defaultMessage="Multi-device" />}
            description={
              <FormattedMessage defaultMessage="Pair and manage remote devices for dictation." />
            }
            action={
              <Button size="small" onClick={openMultiDeviceDialog}>
                <FormattedMessage defaultMessage="Configure" />
              </Button>
            }
          />
        </SettingAnchor>
      )}
      <Section
        title={<FormattedMessage defaultMessage="Danger zone" />}
        description={
          <FormattedMessage defaultMessage="Be careful with these actions. They can have significant consequences for your account." />
        }
      >
        <SettingAnchor settingKey="clear_local_data" highlight={highlight}>
          <ListTile
            title={<FormattedMessage defaultMessage="Clear local data" />}
            leading={<DeleteForeverOutlined />}
            onClick={openClearLocalDataDialog}
          />
        </SettingAnchor>
      </Section>
    </Section>
  );

  const updates = (
    <Section title={<FormattedMessage defaultMessage="Updates" />}>
      <SettingAnchor settingKey="software_update" highlight={highlight}>
        <UpdateSettingSection />
      </SettingAnchor>
      <SettingAnchor
        settingKey="automatically_show_updates"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Automatically show updates" />
          }
          description={
            <FormattedMessage defaultMessage="Automatically open the update window when a new version is available." />
          }
          action={
            <Switch
              edge="end"
              checked={!ignoreUpdateDialog}
              onChange={handleToggleShowUpdates}
            />
          }
        />
      </SettingAnchor>
      <SettingAnchor settingKey="update_channel" highlight={highlight}>
        <UpdateChannelSetting />
      </SettingAnchor>
    </Section>
  );

  const platform = getPlatform();
  const inputSetupTitle = (
    <FormattedMessage defaultMessage="Input permissions" />
  );
  const inputSetupDescription = (() => {
    switch (platform) {
      case "linux":
        return (
          <FormattedMessage defaultMessage="Configures global input capture (uinput/udev) so the pill can type for you. Requires administrator privileges." />
        );
      case "windows":
        return (
          <FormattedMessage defaultMessage="Grants administrator privileges and input-capture access so the pill can type for you. You will see a User Account Control prompt." />
        );
      case "macos":
        return (
          <FormattedMessage defaultMessage="Requests Accessibility and Microphone access so the pill can type for you. You will be prompted in System Settings." />
        );
      default:
        return null;
    }
  })();

  const setupConfirmContent = (() => {
    switch (platform) {
      case "linux":
        return (
          <FormattedMessage defaultMessage="This requires administrator privileges to configure global input capture (uinput/udev). Continue?" />
        );
      case "windows":
        return (
          <FormattedMessage defaultMessage="This will prompt for administrator privileges (UAC) so the pill can capture and type input globally. Continue?" />
        );
      default:
        return (
          <FormattedMessage defaultMessage="This will request Accessibility and Microphone access so the pill can capture and type input globally. Continue?" />
        );
    }
  })();

  const isWindowsPlatform = platform === "windows";
  const alwaysRequestAdminOnStartup = useAppStore(
    (state) => state.userPrefs?.alwaysRequestAdminOnStartup ?? false,
  );

  const handleToggleAlwaysRequestAdmin = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    void setAlwaysRequestAdminOnStartup(event.target.checked);
  };

  const inputPermissionsSetup = (
    <Section title={inputSetupTitle} description={inputSetupDescription}>
      <SettingAnchor
        settingKey="configure_input_permissions"
        highlight={highlight}
      >
        <ListTile
          title={
            <FormattedMessage defaultMessage="Configure input permissions" />
          }
          leading={<KeyboardAltOutlined />}
          disabled={setupRunning}
          onClick={() => setSetupConfirmOpen(true)}
        />
      </SettingAnchor>
      {isWindowsPlatform && (
        <SettingAnchor
          settingKey="always_run_as_administrator"
          highlight={highlight}
        >
          <SettingSection
            title={
              <FormattedMessage defaultMessage="Always run as administrator" />
            }
            description={
              <FormattedMessage defaultMessage="Ask for administrator permission every time mausVoice starts, instead of configuring input permissions manually. Takes effect on the next launch." />
            }
            action={
              <Switch
                edge="end"
                checked={alwaysRequestAdminOnStartup}
                onChange={handleToggleAlwaysRequestAdmin}
              />
            }
          />
        </SettingAnchor>
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
      <SettingAnchor settingKey="input_permissions" highlight={highlight}>
        {inputPermissionsSetup}
      </SettingAnchor>
      <SettingAnchor settingKey="terms_conditions" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Terms & conditions" />}
          onClick={() =>
            openUrl("https://github.com/maus-inc/mausVoice/blob/main/LICENCE")
          }
          trailing={<ArrowOutwardRounded />}
          leading={<DescriptionOutlined />}
        />
      </SettingAnchor>
    </Section>
  );

  return (
    <DashboardEntryLayout>
      <Stack direction="column">
        <Typography
          variant="h4"
          sx={{
            fontWeight: 700,
            marginBottom: 4,
          }}
        >
          <FormattedMessage defaultMessage="Settings" />
        </Typography>
        <TextField
          fullWidth
          size="small"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={intl.formatMessage({
            defaultMessage: "Search settings",
          })}
          slotProps={{
            htmlInput: { "aria-label": "Search settings" },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ mb: 3 }}
        />
        {query.trim() ? (
          <List>
            {results.length === 0 ? (
              <ListItemText
                primary={
                  <FormattedMessage defaultMessage="No settings match that search." />
                }
              />
            ) : (
              results.map((hit) => (
                <ListItemButton
                  key={hit.entry.key}
                  onClick={() => focusSetting(hit.entry.key)}
                >
                  <ListItemText
                    primary={hit.title}
                    secondary={hit.sectionTitle}
                  />
                </ListItemButton>
              ))
            )}
          </List>
        ) : (
          <>
            <Box id="section-general">{general}</Box>
            <Box id="section-dictation">{dictation}</Box>
            <Box id="section-ai-processing">{processing}</Box>
            <Box id="section-pill-appearance">{pillAppearance}</Box>
            <Box id="section-shortcuts">{shortcuts}</Box>
            <Box id="section-privacy-data">{privacyData}</Box>
            <Box id="section-updates">{updates}</Box>
            <Box id="section-advanced">{advanced}</Box>
          </>
        )}
        <Box sx={{ py: 4, textAlign: "center" }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontSize: "0.72rem",
              letterSpacing: "0.02em",
            }}
          >
            <FormattedMessage
              defaultMessage="Engineered with love by {author}"
              values={{
                author: (
                  <Link
                    component="button"
                    onClick={() => openUrl("https://github.com/Owie6789")}
                    underline="hover"
                    sx={{
                      fontWeight: 600,
                      color: "text.secondary",
                      "&:hover": { color: "text.primary" },
                    }}
                  >
                    Owie Emmanuel
                  </Link>
                ),
              }}
            />
          </Typography>
        </Box>
      </Stack>
      <ConfirmDialog
        isOpen={setupConfirmOpen}
        title={
          <FormattedMessage defaultMessage="Configure input permissions" />
        }
        content={setupConfirmContent}
        confirmLabel={<FormattedMessage defaultMessage="Continue" />}
        onCancel={() => setSetupConfirmOpen(false)}
        onConfirm={runNativeSetup}
      />

      <Dialog
        open={deepgramDialogOpen}
        onClose={closeDeepgramDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          <FormattedMessage defaultMessage="Deepgram API key" />
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage defaultMessage="Store your Deepgram API key locally for fast streaming transcription. The key is encrypted before it is saved." />
            </Typography>
            {personalDeepgramApiKey?.keySuffix && (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                <FormattedMessage
                  defaultMessage="Current key ends with {suffix}."
                  values={{ suffix: personalDeepgramApiKey.keySuffix }}
                />
              </Typography>
            )}
            {deepgramError && <Alert severity="error">{deepgramError}</Alert>}
            <TextField
              autoFocus
              fullWidth
              size="small"
              type="password"
              label={<FormattedMessage defaultMessage="API key" />}
              value={deepgramApiKeyInput}
              disabled={deepgramSaving}
              onChange={(event) => setDeepgramApiKeyInput(event.target.value)}
              autoComplete="off"
              slotProps={{
                inputLabel: { shrink: true },
                htmlInput: {
                  "data-mausvoice-ignore": "true",
                },
              }}
            />
            <Link
              component="button"
              variant="body2"
              onClick={() => openUrl("https://console.deepgram.com/")}
              sx={{ alignSelf: "flex-start" }}
            >
              <FormattedMessage defaultMessage="Open Deepgram API keys" />
            </Link>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDeepgramDialog} disabled={deepgramSaving}>
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveDeepgramApiKey}
            disabled={!deepgramApiKeyInput.trim() || deepgramSaving}
          >
            {deepgramSaving ? (
              <FormattedMessage defaultMessage="Saving..." />
            ) : (
              <FormattedMessage defaultMessage="Save" />
            )}
          </Button>
        </DialogActions>
      </Dialog>
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
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              <FormattedMessage defaultMessage="Store your Groq API key locally for transcription and AI post processing. The key is encrypted before it is saved." />
            </Typography>
            {personalGroqApiKey?.keySuffix && (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
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
                  "data-mausvoice-ignore": "true",
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

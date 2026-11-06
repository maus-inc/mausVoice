import {
  AppsOutlined,
  ArrowOutwardRounded,
  AutoAwesomeOutlined,
  AutoFixHighOutlined,
  DeleteForeverOutlined,
  DescriptionOutlined,
  GraphicEqOutlined,
  KeyboardAltOutlined,
  KeyOutlined,
  MicOutlined,
  RocketLaunchOutlined,
  SearchRounded,
  TroubleshootOutlined,
  VolumeUpOutlined,
} from "@mui/icons-material";
import {
  Box,
  Button,
  Chip,
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
  useEffect,
  useMemo,
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
  setElevenLabsKeytermsEnabled,
  setMenuBarIconHidden,
  setPillResetMonitorStrategy,
  setPreserveAudioOnFailure,
  setRealtimeOutputEnabled,
  setReviewBeforeInsert,
  setSpokenCommandsEnabled,
  setStylingMode,
} from "../../actions/user.actions";
import { logOnRejection } from "../../utils/promise.utils";
import {
  MAX_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
} from "../../utils/dictation-limit.utils";
import {
  MAX_HANDS_FREE_DELAY_MS,
  normalizeHandsFreeDelayMs,
} from "../../utils/hands-free-delay.utils";
import {
  isPillPlacementAvailable,
  PillPlacementSetting,
} from "./PillPlacementSetting";
import { UpdateChannelSetting } from "./UpdateChannelSetting";
import { useSettingsNavigation } from "./useSettingsNavigation";
import { selectSettingsPageSnapshot } from "./settings-page-snapshot";
import { AudioTransmissionDisclosure } from "./AudioTransmissionDisclosure";
import { DictationLanguageSetting } from "./DictationLanguageSetting";
import {
  PersonalApiKeyDialog,
  usePersonalApiKeyDialog,
} from "./PersonalApiKeyDialog";
import { UpdateSettingSection } from "./UpdateSettingSection";
import { sectionAnchorId, SettingsSectionNav } from "./SettingsSectionNav";
import { SegmentedControl } from "../common/SegmentedControl";
import {
  searchSettings,
  SETTING_ENTRIES,
  type SettingAvailability,
} from "../../utils/settings-registry";
import { produceAppState, useAppStore } from "../../store";
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

const useNativeInputSetup = () => {
  const alwaysRequestAdminOnStartup = useAppStore(
    (state) => state.userPrefs?.alwaysRequestAdminOnStartup ?? false,
  );
  const [setupConfirmOpen, setSetupConfirmOpen] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const setupInFlight = useRef(false);

  const runNativeSetup = async () => {
    if (setupInFlight.current) return;
    setupInFlight.current = true;
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
      setupInFlight.current = false;
      setSetupRunning(false);
    }
  };
  return {
    setupConfirmOpen,
    setSetupConfirmOpen,
    setupRunning,
    runNativeSetup,
    alwaysRequestAdminOnStartup,
  };
};

/** A draft stays local until blur; external changes replace the draft. */
const useNumericSettingInput = ({
  value,
  enabled = true,
  normalize,
  save,
  context,
}: {
  value: number;
  enabled?: boolean;
  normalize: (value: number) => number;
  save: (value: number) => Promise<void>;
  context: string;
}) => {
  const [input, setInput] = useState(String(value));
  const lastCommitted = useRef(value);
  const latestValue = useRef(value);
  const revision = useRef(0);
  useEffect(() => {
    latestValue.current = value;
    lastCommitted.current = value;
    setInput(String(value));
  }, [value]);
  const onChange = (event: ChangeEvent<HTMLInputElement>) =>
    setInput(event.target.value);
  const onBlur = () => {
    if (!enabled) return;
    const parsed = Number(input);
    if (input === "" || !Number.isFinite(parsed) || parsed < 0) {
      setInput(String(value));
      return;
    }
    const normalized = normalize(parsed);
    setInput(String(normalized));
    if (normalized === lastCommitted.current) return;
    lastCommitted.current = normalized;
    const attempt = ++revision.current;
    logOnRejection(
      save(normalized).catch((error: unknown) => {
        if (revision.current === attempt)
          lastCommitted.current = latestValue.current;
        throw error;
      }),
      context,
    );
  };
  return { input, onChange, onBlur };
};

const getInputSetupDescription = (platform: ReturnType<typeof getPlatform>) => {
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
};

const getSetupConfirmContent = (platform: ReturnType<typeof getPlatform>) => {
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
};

const ConfigurationStatusChip = ({ configured }: { configured: boolean }) => (
  <Chip
    size="small"
    color={configured ? "success" : "default"}
    label={
      configured ? (
        <FormattedMessage defaultMessage="Configured" />
      ) : (
        <FormattedMessage defaultMessage="Not configured" />
      )
    }
  />
);

const SettingsSearchResults = ({
  results,
  focusSetting,
}: {
  results: ReturnType<typeof searchSettings>;
  focusSetting: (key: string) => void;
}) => (
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
          <ListItemText primary={hit.title} secondary={hit.sectionTitle} />
        </ListItemButton>
      ))
    )}
  </List>
);

type PrivacySectionProps = {
  highlight: string | null;
  availability: SettingAvailability;
  values: {
    showAudioDisclosure: boolean;
    incognitoModeEnabled: boolean;
    incognitoIncludeInStats: boolean;
    preserveAudioOnFailure: boolean;
    autoLearnDictionaryEnabled: boolean;
    elevenLabsKeytermsEnabled: boolean;
    autoLearnFromEditsEnabled: boolean;
  };
  actions: {
    handleToggleIncognitoMode: (event: ChangeEvent<HTMLInputElement>) => void;
    handleToggleIncognitoIncludeInStats: (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    handleTogglePreserveAudioOnFailure: (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    handleToggleAutoLearnDictionary: (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    handleToggleElevenLabsKeyterms: (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    handleToggleAutoLearnFromEdits: (
      event: ChangeEvent<HTMLInputElement>,
    ) => void;
    openMultiDeviceDialog: () => void;
    openClearLocalDataDialog: () => void;
  };
};

const PrivacySection = ({
  highlight,
  availability,
  values,
  actions,
}: PrivacySectionProps) => {
  const {
    showAudioDisclosure,
    incognitoModeEnabled,
    incognitoIncludeInStats,
    preserveAudioOnFailure,
    autoLearnDictionaryEnabled,
    elevenLabsKeytermsEnabled,
    autoLearnFromEditsEnabled,
  } = values;
  const {
    handleToggleIncognitoMode,
    handleToggleIncognitoIncludeInStats,
    handleTogglePreserveAudioOnFailure,
    handleToggleAutoLearnDictionary,
    handleToggleElevenLabsKeyterms,
    handleToggleAutoLearnFromEdits,
    openMultiDeviceDialog,
    openClearLocalDataDialog,
  } = actions;
  return (
    <Section title={<FormattedMessage defaultMessage="Privacy and data" />}>
      {showAudioDisclosure && (
        <SettingAnchor
          settingKey="where_your_dictation_audio_goes"
          highlight={highlight}
        >
          <SettingSection
            title={
              <FormattedMessage defaultMessage="Where your dictation audio goes" />
            }
            description={<AudioTransmissionDisclosure variant="setting" />}
          />
        </SettingAnchor>
      )}
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
      {availability.include_incognito_in_stats && (
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
      <SettingAnchor
        settingKey="preserve_audio_on_failure"
        highlight={highlight}
      >
        <SettingSection
          title={
            <FormattedMessage defaultMessage="Preserve audio on failure" />
          }
          description={
            <FormattedMessage defaultMessage="Keep the audio snapshot with a failed transcription so you can replay it from History. Incognito recordings are never saved." />
          }
          action={
            <Switch
              edge="end"
              checked={preserveAudioOnFailure}
              onChange={handleTogglePreserveAudioOnFailure}
            />
          }
        />
      </SettingAnchor>
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
      {availability.elevenlabs_keyterms && (
        <SettingAnchor settingKey="elevenlabs_keyterms" highlight={highlight}>
          <SettingSection
            title={<FormattedMessage defaultMessage="ElevenLabs keyterms" />}
            description={
              <FormattedMessage defaultMessage="Send your dictionary to ElevenLabs as keyterms so it recognizes your words. This adds a 20% surcharge to every ElevenLabs transcription, so it is off by default." />
            }
            action={
              <Switch
                edge="end"
                checked={elevenLabsKeytermsEnabled}
                onChange={handleToggleElevenLabsKeyterms}
              />
            }
          />
        </SettingAnchor>
      )}
      {availability.learn_from_corrections && (
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
};

const useElevenLabsSurcharge = () => {
  const [confirmElevenLabsSurcharge, setConfirmElevenLabsSurcharge] =
    useState(false);
  const handleToggleElevenLabsKeyterms = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    // Turning this on adds a 20% ElevenLabs transcription surcharge, so the
    // opt-in only persists after the user acknowledges the cost.
    if (event.target.checked) {
      setConfirmElevenLabsSurcharge(true);
      return;
    }
    logOnRejection(
      setElevenLabsKeytermsEnabled(false),
      "settings page: setElevenLabsKeytermsEnabled",
    );
  };

  const acknowledgeElevenLabsSurcharge = () => {
    setConfirmElevenLabsSurcharge(false);
    logOnRejection(
      setElevenLabsKeytermsEnabled(true),
      "settings page: setElevenLabsKeytermsEnabled",
    );
  };

  const dismissElevenLabsSurcharge = () => {
    setConfirmElevenLabsSurcharge(false);
  };

  return {
    confirmElevenLabsSurcharge,
    handleToggleElevenLabsKeyterms,
    acknowledgeElevenLabsSurcharge,
    dismissElevenLabsSurcharge,
  };
};

const StyleLoadingSettings = ({
  highlight,
  availability,
  disableAutoStyleLoading,
  stylingMode,
  onToggleAutoStyleLoading,
  onStylingModeChange,
}: {
  highlight: string | null;
  availability: SettingAvailability;
  disableAutoStyleLoading: boolean;
  stylingMode: StylingMode;
  onToggleAutoStyleLoading: (event: ChangeEvent<HTMLInputElement>) => void;
  onStylingModeChange: (event: SelectChangeEvent<string>) => void;
}) => {
  const intl = useIntl();
  return (
    <>
      {availability.automatic_style_loading && (
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
                onChange={onToggleAutoStyleLoading}
              />
            }
          />
        </SettingAnchor>
      )}
      {availability.styling_mode && (
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
                onChange={onStylingModeChange}
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
    </>
  );
};

/** Keeps each provider's key inventory and editor under the same owner. */
const usePersonalProviderKeys = () => {
  const groqKeyDialog = usePersonalApiKeyDialog(savePersonalGroqApiKey, "Groq");
  const deepgramKeyDialog = usePersonalApiKeyDialog(
    savePersonalDeepgramApiKey,
    "Deepgram",
  );

  const personalGroqApiKey = useAppStore((state) =>
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.id === PERSONAL_GROQ_API_KEY_ID ||
        (apiKey.provider === "groq" &&
          apiKey.name.trim() === PERSONAL_GROQ_API_KEY_NAME),
    ),
  );
  const personalDeepgramApiKey = useAppStore((state) =>
    state.settings.apiKeys.find(
      (apiKey) =>
        apiKey.id === PERSONAL_DEEPGRAM_API_KEY_ID ||
        (apiKey.provider === "deepgram" &&
          apiKey.name.trim() === PERSONAL_DEEPGRAM_API_KEY_NAME),
    ),
  );
  return {
    groqKeyDialog,
    deepgramKeyDialog,
    personalGroqApiKey,
    personalDeepgramApiKey,
  };
};

/** Draft and commit timing settings together while keeping their values independent. */
const useDictationTimingSettings = (
  dictationLimitMinutes: number,
  showDictationLimitSetting: boolean,
  handsFreeDelayMs: number,
) => {
  const dictationLimit = useNumericSettingInput({
    value: dictationLimitMinutes,
    enabled: showDictationLimitSetting,
    normalize: normalizeDictationLimitMinutes,
    save: setDictationLimitMinutes,
    context: "settings page: setDictationLimitMinutes",
  });
  const handsFreeDelay = useNumericSettingInput({
    value: handsFreeDelayMs,
    normalize: normalizeHandsFreeDelayMs,
    save: setHandsFreeDelayMs,
    context: "settings page: setHandsFreeDelayMs",
  });

  return { dictationLimit, handsFreeDelay };
};

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const {
    query,
    setQuery,
    highlight,
    focusSetting,
    activeSection,
    jumpToSection,
  } = useSettingsNavigation();

  const {
    setupConfirmOpen,
    setSetupConfirmOpen,
    setupRunning,
    runNativeSetup,
    alwaysRequestAdminOnStartup,
  } = useNativeInputSetup();
  const {
    groqKeyDialog,
    deepgramKeyDialog,
    personalGroqApiKey,
    personalDeepgramApiKey,
  } = usePersonalProviderKeys();
  const [autoLaunchEnabled, autoLaunchStatus] = useAppStore((state) => [
    state.settings.autoLaunchEnabled,
    state.settings.autoLaunchStatus,
  ]);
  const autoLaunchLoading = autoLaunchStatus === "loading";
  const intl = useIntl();

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
    preserveAudioOnFailure,
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
    elevenLabsKeytermsEnabled,
    spokenCommandsEnabled,
    reviewBeforeInsert,
    hallucinationFilterEnabled,
    inDictationStyleSwitchingEnabled,
    transcriptionProvider,
    showAudioDisclosure,
  ] = useAppStore(selectSettingsPageSnapshot);
  const platform = getPlatform();
  // Read the same snapshot as the rest of this file. `isMacOS`/`isWindows` test
  // the raw platform name ("darwin", "win32") while `getPlatform` maps it to
  // "macos"/"windows", so the pair never matched on either desktop platform and
  // the correction-watch setting was hidden on both.
  const supportsCorrectionWatch =
    platform === "macos" || platform === "windows";
  // Rendering, search and deep links consume the same availability snapshot.
  const availability = useMemo<SettingAvailability>(
    () => ({
      dictation_limit_minutes: showDictationLimitSetting,
      automatic_style_loading: stylingMode === "manual",
      styling_mode: canChangeStylingMode,
      include_incognito_in_stats: incognitoModeEnabled,
      learn_from_corrections: supportsCorrectionWatch,
      always_run_as_administrator: platform === "windows",
      // Search and `?setting=` deep links read this snapshot, so a control the
      // platform does not render has to read unavailable here too.
      pill_placement: isPillPlacementAvailable(),
      elevenlabs_keyterms: transcriptionProvider === "elevenlabs",
      where_your_dictation_audio_goes: showAudioDisclosure,
    }),
    [
      showDictationLimitSetting,
      stylingMode,
      canChangeStylingMode,
      incognitoModeEnabled,
      supportsCorrectionWatch,
      platform,
      transcriptionProvider,
      showAudioDisclosure,
    ],
  );

  // Deep links (`settings?section=<id>&setting=<id>`) from tips, error
  // recovery, and update prompts. A setting link scrolls to the row and
  // highlights it; a bare section link scrolls to the section.
  useEffect(() => {
    const setting = searchParams.get("setting");
    if (
      setting &&
      availability[setting] !== false &&
      SETTING_ENTRIES.some((entry) => entry.key === setting)
    ) {
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
  }, [searchParams, focusSetting, availability]);

  const results = searchSettings(query, {
    availability,
    messages: intl.messages,
  });
  const {
    confirmElevenLabsSurcharge,
    handleToggleElevenLabsKeyterms,
    acknowledgeElevenLabsSurcharge,
    dismissElevenLabsSurcharge,
  } = useElevenLabsSurcharge();
  const { dictationLimit, handsFreeDelay } = useDictationTimingSettings(
    dictationLimitMinutes,
    showDictationLimitSetting,
    handsFreeDelayMs,
  );

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

  const handleTogglePreserveAudioOnFailure = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setPreserveAudioOnFailure(event.target.checked),
      "settings page: setPreserveAudioOnFailure",
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

  const handleStylingModeChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    logOnRejection(
      setStylingMode(value === "" ? null : (value as StylingMode)),
      "settings page: setStylingMode",
    );
  };

  // Intentionally available on every platform: multi-device pairing talks to
  // LAN peers over the same IPC path on macOS, Windows, and Linux, so unlike
  // the admin/correction helpers there is no OS-specific capability gate.
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
          disableRipple
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

  const dictation = (
    <Section title={<FormattedMessage defaultMessage="Dictation" />}>
      <SettingAnchor settingKey="dictation_language" highlight={highlight}>
        <DictationLanguageSetting
          openPostProcessingDialog={openPostProcessingDialog}
        />
      </SettingAnchor>
      <SettingAnchor settingKey="text_insertion_options" highlight={highlight}>
        <ListTile
          title={<FormattedMessage defaultMessage="Text insertion options" />}
          leading={<AppsOutlined />}
          onClick={openAppKeybindingsDialog}
        />
      </SettingAnchor>
      {availability.dictation_limit_minutes && (
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
                value={dictationLimit.input}
                onChange={dictationLimit.onChange}
                onBlur={dictationLimit.onBlur}
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
              value={handsFreeDelay.input}
              onChange={handsFreeDelay.onChange}
              onBlur={handsFreeDelay.onBlur}
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
          onClick={deepgramKeyDialog.show}
          trailing={
            <ConfigurationStatusChip configured={!!personalDeepgramApiKey} />
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
          onClick={groqKeyDialog.show}
          trailing={
            <ConfigurationStatusChip configured={!!personalGroqApiKey} />
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
      <StyleLoadingSettings
        highlight={highlight}
        availability={availability}
        disableAutoStyleLoading={disableAutoStyleLoading}
        stylingMode={stylingMode}
        onToggleAutoStyleLoading={handleToggleAutoStyleLoading}
        onStylingModeChange={handleStylingModeChange}
      />
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
                {
                  value: "current",
                  label: intl.formatMessage({
                    defaultMessage: "Current monitor",
                  }),
                },
                {
                  value: "cursor",
                  label: intl.formatMessage({
                    defaultMessage: "Cursor monitor",
                  }),
                },
              ]}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Reset pill position monitor",
              })}
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
    <PrivacySection
      highlight={highlight}
      availability={availability}
      values={{
        showAudioDisclosure,
        incognitoModeEnabled,
        incognitoIncludeInStats,
        preserveAudioOnFailure,
        autoLearnDictionaryEnabled,
        elevenLabsKeytermsEnabled,
        autoLearnFromEditsEnabled,
      }}
      actions={{
        handleToggleIncognitoMode,
        handleToggleIncognitoIncludeInStats,
        handleTogglePreserveAudioOnFailure,
        handleToggleAutoLearnDictionary,
        handleToggleElevenLabsKeyterms,
        handleToggleAutoLearnFromEdits,
        openMultiDeviceDialog,
        openClearLocalDataDialog,
      }}
    />
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

  const inputSetupTitle = (
    <FormattedMessage defaultMessage="Input permissions" />
  );
  const inputSetupDescription = getInputSetupDescription(platform);
  const setupConfirmContent = getSetupConfirmContent(platform);

  const handleToggleAlwaysRequestAdmin = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setAlwaysRequestAdminOnStartup(event.target.checked),
      "admin startup preference",
    );
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
      {availability.always_run_as_administrator && (
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
            htmlInput: {
              "aria-label": intl.formatMessage({
                defaultMessage: "Search settings",
              }),
            },
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
          <SettingsSearchResults
            results={results}
            focusSetting={focusSetting}
          />
        ) : (
          <Stack direction="row" spacing={4} sx={{ alignItems: "flex-start" }}>
            <SettingsSectionNav
              active={activeSection}
              onSelect={jumpToSection}
            />
            {/* Anchors come from the same helper the rail scrolls with, so a
                section id cannot exist here under one spelling and be looked
                up under another. The order is the registry's, which is what
                keeps the rail and the page reading the same way down. */}
            <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
              <Box id={sectionAnchorId("general")}>{general}</Box>
              <Box id={sectionAnchorId("dictation")}>{dictation}</Box>
              <Box id={sectionAnchorId("ai-processing")}>{processing}</Box>
              <Box id={sectionAnchorId("pill-appearance")}>
                {pillAppearance}
              </Box>
              <Box id={sectionAnchorId("shortcuts")}>{shortcuts}</Box>
              <Box id={sectionAnchorId("privacy-data")}>{privacyData}</Box>
              <Box id={sectionAnchorId("updates")}>{updates}</Box>
              <Box id={sectionAnchorId("advanced")}>{advanced}</Box>
            </Stack>
          </Stack>
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
      <ConfirmDialog
        isOpen={confirmElevenLabsSurcharge}
        title={
          <FormattedMessage defaultMessage="Enable ElevenLabs keyterms?" />
        }
        content={
          <FormattedMessage defaultMessage="Sending your dictionary as ElevenLabs keyterms adds a 20% surcharge to every ElevenLabs transcription. Only your non-empty dictionary is sent, and you can turn this off at any time." />
        }
        confirmLabel={
          <FormattedMessage defaultMessage="Enable with 20% surcharge" />
        }
        onCancel={dismissElevenLabsSurcharge}
        onConfirm={acknowledgeElevenLabsSurcharge}
      />

      <PersonalApiKeyDialog
        state={deepgramKeyDialog}
        suffix={personalDeepgramApiKey?.keySuffix}
        title={<FormattedMessage defaultMessage="Deepgram API key" />}
        description={
          <FormattedMessage defaultMessage="Store your Deepgram API key locally for fast streaming transcription. The key is encrypted before it is saved." />
        }
        keyUrl="https://console.deepgram.com/"
        linkLabel={<FormattedMessage defaultMessage="Open Deepgram API keys" />}
      />
      <PersonalApiKeyDialog
        state={groqKeyDialog}
        suffix={personalGroqApiKey?.keySuffix}
        title={<FormattedMessage defaultMessage="Groq API key" />}
        description={
          <FormattedMessage defaultMessage="Store your Groq API key locally for transcription and AI post processing. The key is encrypted before it is saved." />
        }
        placeholder={intl.formatMessage({ defaultMessage: "gsk_..." })}
        keyUrl="https://console.groq.com/keys"
        linkLabel={<FormattedMessage defaultMessage="Open Groq API keys" />}
      />
    </DashboardEntryLayout>
  );
}

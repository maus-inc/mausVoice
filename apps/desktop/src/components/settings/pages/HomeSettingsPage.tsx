import { AudioLines, Bot, WandSparkles } from "lucide-react";
import { Box, Stack, Typography } from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import type { ApiKeyProvider } from "@maus-inc/types";
import { useAppStore } from "../../../store";
import type { AppState } from "../../../state/app.state";
import { getProviderDisplayName } from "../api-key-provider-config";
import type { ApiKeyListContext } from "../ApiKeyList";
import { HotkeyBadge } from "../../common/HotkeyBadge";
import {
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  OPEN_CHAT_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  getHotkeyCombosForAction,
} from "../../../utils/keyboard.utils";
import { getEffectiveStylingMode } from "../../../utils/feature.utils";
import {
  LOCAL_MODEL_OPTIONS,
  normalizeLocalWhisperModel,
} from "../../../utils/local-transcription.utils";
import {
  getEffectiveAgentMode,
  getEffectivePostProcessingMode,
  getEffectiveTranscriptionMode,
  getSelectedTranscriptionProvider,
} from "../../../utils/user.utils";
import { SettingGroup } from "../SettingRow";
import { SettingSummaryRow } from "../SettingSummaryRow";
import { settingsPagePath } from "../settings-routes";

/**
 * The overview: the two things a person opens settings to check, as cards that
 * answer at a glance and hand the full page the moment they are clicked.
 *
 * Every row here is a summary of a row that lives on another page, so each one
 * names its registry key and links to that row's anchor. Nothing on this page
 * carries an anchor of its own — see `SettingSummaryRow`.
 */

/**
 * The shortcut rows, in the order the shortcuts dialog lists them and with the
 * dialog's own wording, so a row here and the row it opens cannot describe
 * different keys.
 *
 * Two deliberate absences. "Add to dictionary" acts on a selection that only
 * exists mid-dictation, so it is not a key someone reaches for from a settings
 * window. The assistant's key is absent because the assistant is a mode: its
 * own card reports it, and listing the key here would put "Assistant mode" in
 * both cards at once, meaning a key in one and a model in the other.
 */
const SHORTCUT_ROWS = [
  {
    action: DICTATE_HOTKEY,
    target: "hotkey_shortcuts",
    title: <FormattedMessage defaultMessage="Hold to dictate" />,
  },
  {
    action: CANCEL_TRANSCRIPTION_HOTKEY,
    target: "hotkey_shortcuts",
    title: <FormattedMessage defaultMessage="Cancel transcription" />,
  },
  {
    action: OPEN_CHAT_HOTKEY,
    target: "hotkey_shortcuts",
    title: <FormattedMessage defaultMessage="Open chat" />,
  },
] as const;

/** The style-cycling keys, which exist only while styling is manual. */
const STYLE_SHORTCUT_ROWS = [
  {
    action: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    target: "style_hotkeys",
    title: <FormattedMessage defaultMessage="Previous writing style" />,
  },
  {
    action: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    target: "style_hotkeys",
    title: <FormattedMessage defaultMessage="Next writing style" />,
  },
] as const;

/**
 * The combo currently bound to one action, or the fact that none is.
 *
 * Read with the same selector the shortcuts dialog uses, so the overview cannot
 * report a key the dialog does not show — including the platform defaults a
 * fresh install runs on.
 */
const BoundHotkeys = ({ action }: { action: string }) => {
  const combo = useAppStore(
    (state) => getHotkeyCombosForAction(state, action)[0] ?? null,
  );

  if (!combo) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        <FormattedMessage defaultMessage="Not set" />
      </Typography>
    );
  }

  return <HotkeyBadge keys={combo} />;
};

const QuickShortcutsCard = () => {
  const manualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );

  const rows = manualStyling
    ? [...SHORTCUT_ROWS, ...STYLE_SHORTCUT_ROWS]
    : SHORTCUT_ROWS;

  return (
    <SettingGroup title={<FormattedMessage defaultMessage="Shortcuts" />}>
      {rows.map((row) => (
        <SettingSummaryRow
          key={row.action}
          linksTo={row.target}
          title={row.title}
          control={<BoundHotkeys action={row.action} />}
        />
      ))}
      <SettingSummaryRow
        path={settingsPagePath("shortcuts")}
        title={<FormattedMessage defaultMessage="All shortcuts" />}
      />
    </SettingGroup>
  );
};

/** The provider a key id belongs to, without resolving the key itself. */
const providerOfKey = (
  state: AppState,
  keyId: string | null,
): ApiKeyProvider | null => {
  const key = keyId ? state.apiKeyById[keyId] : undefined;
  return (key?.provider as ApiKeyProvider | undefined) ?? null;
};

/**
 * One model row's state, resolved to the words the row shows.
 *
 * `attention` is set only where the app knows the choice is unfinished: a
 * provider mode with no provider selected, or a local model whose status has
 * loaded and says it is not on disk. An unloaded status says nothing, so it
 * does not raise one.
 */
type ModelSummary = {
  description: string;
  value: string | null;
  attention: boolean;
};

const YourModelsCard = () => {
  const intl = useIntl();

  const [
    transcriptionMode,
    transcriptionModel,
    transcriptionReady,
    transcriptionStatusesLoaded,
    transcriptionProvider,
  ] = useAppStore((state) => {
    const config = state.settings.aiTranscription;
    const model = normalizeLocalWhisperModel(config.modelSize);
    const status = config.localModelManagement.modelStatuses[model];
    return [
      getEffectiveTranscriptionMode(state),
      model,
      Boolean(status?.downloaded && status?.valid),
      config.localModelManagement.modelStatusesLoaded,
      getSelectedTranscriptionProvider(state),
    ] as const;
  });

  const [postProcessingMode, postProcessingProvider] = useAppStore((state) => [
    getEffectivePostProcessingMode(state),
    providerOfKey(state, state.settings.aiPostProcessing.selectedApiKeyId),
  ]);

  const [agentMode, agentProvider] = useAppStore((state) => [
    getEffectiveAgentMode(state),
    providerOfKey(state, state.settings.agentMode.selectedApiKeyId),
  ]);

  const localModel = LOCAL_MODEL_OPTIONS.find(
    (option) => option.value === transcriptionModel,
  );

  const cloud = intl.formatMessage({ defaultMessage: "Cloud" });
  const onThisComputer = intl.formatMessage({
    defaultMessage: "On this computer",
  });
  // The same words the AI models page puts on its configured chip: a state the
  // overview reports and the page decides must not have two names.
  const notConfigured = intl.formatMessage({
    defaultMessage: "Not configured",
  });
  const off = intl.formatMessage({ defaultMessage: "Off" });

  const apiProviderOf = (
    provider: ApiKeyProvider | null,
    context: ApiKeyListContext,
  ): ModelSummary => {
    const name = provider ? getProviderDisplayName(provider, context) : null;
    return {
      description: name ?? notConfigured,
      value: name ? cloud : null,
      attention: name === null,
    };
  };

  // A loaded status that says "not on disk" is the only thing that makes the
  // missing-model word true; before the statuses load, the app does not know.
  const localModelMissing = transcriptionStatusesLoaded && !transcriptionReady;

  const transcriptionSummary: ModelSummary =
    transcriptionMode === "local"
      ? {
          description: localModelMissing
            ? intl.formatMessage({ defaultMessage: "Not downloaded yet" })
            : localModel
              ? intl.formatMessage(localModel.label)
              : transcriptionModel,
          value: onThisComputer,
          attention: localModelMissing,
        }
      : apiProviderOf(transcriptionProvider, "transcription");

  const postProcessingSummary =
    postProcessingMode === "none"
      ? { description: off, value: null, attention: false }
      : apiProviderOf(postProcessingProvider, "post-processing");

  const agentSummary =
    agentMode === "none"
      ? { description: off, value: null, attention: false }
      : apiProviderOf(agentProvider, "post-processing");

  return (
    <SettingGroup title={<FormattedMessage defaultMessage="Your models" />}>
      <SettingSummaryRow
        linksTo="ai_transcription"
        icon={<AudioLines size={20} strokeWidth={1.9} />}
        title={<FormattedMessage defaultMessage="AI transcription" />}
        attention={transcriptionSummary.attention}
        description={transcriptionSummary.description}
        value={transcriptionSummary.value}
      />
      <SettingSummaryRow
        linksTo="ai_post_processing"
        icon={<WandSparkles size={20} strokeWidth={1.9} />}
        title={<FormattedMessage defaultMessage="AI post processing" />}
        attention={postProcessingSummary.attention}
        description={postProcessingSummary.description}
        value={postProcessingSummary.value}
      />
      <SettingSummaryRow
        linksTo="assistant_mode"
        icon={<Bot size={20} strokeWidth={1.9} />}
        title={<FormattedMessage defaultMessage="Assistant mode" />}
        attention={agentSummary.attention}
        description={agentSummary.description}
        value={agentSummary.value}
      />
      <SettingSummaryRow
        path={settingsPagePath("ai-models")}
        title={<FormattedMessage defaultMessage="Manage models" />}
      />
    </SettingGroup>
  );
};

export default function HomeSettingsPage() {
  return (
    <Stack
      direction="row"
      sx={{
        // Two cards side by side when there is room for both to hold a row,
        // stacked when there is not. A media query would have to guess where
        // that line falls; the row's own minimum width is the line.
        flexWrap: "wrap",
        gap: 4,
        alignItems: "flex-start",
        "& > *": { flex: "1 1 340px", minWidth: 0 },
      }}
    >
      <Box>
        <QuickShortcutsCard />
      </Box>
      <Box>
        <YourModelsCard />
      </Box>
    </Stack>
  );
}

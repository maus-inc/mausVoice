import { AudioLines, Bot, WandSparkles } from "lucide-react";
import { ProviderLogo } from "../../common/provider-logos/ProviderLogo";
import { Alert, Chip, Stack } from "@mui/material";
import type { ApiKey, StylingMode } from "@maus-inc/types";
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../../store";
import type { ActionStatus } from "../../../types/state.types";
import { getMyUserPreferences } from "../../../utils/user.utils";
import {
  setFastStyleShortDictationsEnabled,
  setStylingMode,
} from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import { getEffectiveStylingMode } from "../../../utils/feature.utils";
import {
  apiKeyNeedsAttention,
  apiKeyNeedsReentry,
  countApiKeysNeedingAttention,
  isApiKeyUsable,
} from "../../../utils/api-key.utils";
import { findPersonalApiKey } from "../../../utils/personal-use.utils";
import { SegmentedControl } from "../../common/SegmentedControl";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { openAssistantModeDialog } from "../../../actions/assistant-mode.actions";
import { setTipAction } from "../../onboarding/tip-actions";
import { useSettingsFocus } from "../settings-highlight";
import { useSettingsAvailability } from "../settings-availability";
import {
  PersonalApiKeyDialog,
  type PersonalApiKeyProvider,
} from "../PersonalApiKeyDialog";

const openDialog = (
  key: "aiTranscriptionDialogOpen" | "aiPostProcessingDialogOpen",
) => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

const ApiKeyStatusChip = ({
  apiKey,
  apiKeysStatus,
}: {
  apiKey: ApiKey | null;
  apiKeysStatus: ActionStatus;
}) => {
  if (!apiKey) {
    if (apiKeysStatus !== "success") {
      return null;
    }
    return (
      <Chip
        size="small"
        color="default"
        label={<FormattedMessage defaultMessage="Not configured" />}
      />
    );
  }
  if (apiKeyNeedsReentry(apiKey)) {
    return (
      <Chip
        size="small"
        color="warning"
        label={<FormattedMessage defaultMessage="Re-enter key" />}
      />
    );
  }
  if (apiKeyNeedsAttention(apiKey)) {
    return (
      <Chip
        size="small"
        color="warning"
        label={<FormattedMessage defaultMessage="Needs attention" />}
      />
    );
  }
  return (
    <Chip
      size="small"
      color="success"
      label={<FormattedMessage defaultMessage="Configured" />}
    />
  );
};

type SelectedKeyAttentionState = "reentry" | "attention" | null;

const getSelectedKeyAttentionState = (
  apiKeyById: Record<string, ApiKey | undefined>,
  mode: string | null | undefined,
  selectedApiKeyId: string | null | undefined,
  apiKeysStatus: ActionStatus,
): SelectedKeyAttentionState => {
  if (mode !== "api" || !selectedApiKeyId) {
    return null;
  }
  const key = apiKeyById[selectedApiKeyId];
  if (!key) {
    return apiKeysStatus === "success" ? "attention" : null;
  }
  if (isApiKeyUsable(key)) {
    return null;
  }
  return apiKeyNeedsReentry(key) ? "reentry" : "attention";
};

const SelectedKeyAttentionChip = ({
  state,
}: {
  state: Exclude<SelectedKeyAttentionState, null>;
}) => (
  <Chip
    size="small"
    color="warning"
    label={
      state === "reentry" ? (
        <FormattedMessage defaultMessage="Re-enter key" />
      ) : (
        <FormattedMessage defaultMessage="Needs attention" />
      )
    }
  />
);

const renderPersonalKeyChip = (
  apiKey: ApiKey | null,
  apiKeysStatus: ActionStatus,
) =>
  apiKey || apiKeysStatus === "success" ? (
    <ApiKeyStatusChip apiKey={apiKey} apiKeysStatus={apiKeysStatus} />
  ) : undefined;

const AiModelsAttentionBanner = ({
  attentionKeyCount,
  removedCloudModesCount,
}: {
  attentionKeyCount: number;
  removedCloudModesCount: number;
}) => {
  if (attentionKeyCount <= 0 && removedCloudModesCount <= 0) {
    return null;
  }
  return (
    <Stack spacing={1.5} sx={{ mb: 3 }}>
      {attentionKeyCount > 0 && (
        <Alert severity="warning" sx={{ boxShadow: "none" }}>
          <FormattedMessage
            defaultMessage="{count, plural, one {# saved API provider below needs attention before it can be used.} other {# saved API providers below need attention before they can be used.}}"
            values={{ count: attentionKeyCount }}
          />
        </Alert>
      )}
      {removedCloudModesCount > 0 && (
        <Alert severity="info" sx={{ boxShadow: "none" }}>
          <FormattedMessage defaultMessage="Previous Voquill Cloud mode selections were reset to local or off during migration. Choose a local model or personal API provider below." />
        </Alert>
      )}
    </Stack>
  );
};

export default function AiModelsSettingsPage() {
  const intl = useIntl();
  const availability = useSettingsAvailability();
  const focusSetting = useSettingsFocus();
  const [keyDialog, setKeyDialog] = useState<PersonalApiKeyProvider | null>(
    null,
  );

  // The generative-provider tip floats in the corner stack (TipToaster) while
  // this page is open, and its Add API key action completes the task in place:
  // it reveals the Groq key row (the layout scrolls it into view and lights it
  // up) and opens the key dialog, whose input takes focus once it has entered.
  // The page owns the handler because it mutates this page's dialog state.
  useEffect(
    () =>
      setTipAction("generative-provider", () => {
        focusSetting("groq_api_key");
        setKeyDialog("groq");
      }),
    [focusSetting],
  );

  const [
    apiKeysStatus,
    deepgramKey,
    groqKey,
    attentionKeyCount,
    transcriptionAttentionState,
    postProcessingAttentionState,
    agentAttentionState,
    removedCloudModesCount,
    stylingMode,
    disableAutoStyleLoading,
    fastStyleShortDictationsEnabled,
    postProcessingMode,
  ] = useAppStore(
    (state) =>
      [
        state.settings.apiKeysStatus,
        findPersonalApiKey(state.settings.apiKeys, "deepgram"),
        findPersonalApiKey(state.settings.apiKeys, "groq"),
        countApiKeysNeedingAttention(state.settings.apiKeys),
        getSelectedKeyAttentionState(
          state.apiKeyById,
          state.settings.aiTranscription.mode,
          state.settings.aiTranscription.selectedApiKeyId,
          state.settings.apiKeysStatus,
        ),
        getSelectedKeyAttentionState(
          state.apiKeyById,
          state.settings.aiPostProcessing.mode,
          state.settings.aiPostProcessing.selectedApiKeyId,
          state.settings.apiKeysStatus,
        ),
        getSelectedKeyAttentionState(
          state.apiKeyById,
          state.settings.agentMode.mode,
          state.settings.agentMode.selectedApiKeyId,
          state.settings.apiKeysStatus,
        ),
        state.voquillMigration.report?.removedModesReset.length ?? 0,
        getEffectiveStylingMode(state),
        state.local.disableAutoStyleLoading ?? false,
        getMyUserPreferences(state)?.fastStyleShortDictationsEnabled ?? true,
        state.settings.aiPostProcessing.mode,
      ] as const,
  );

  const handleStylingModeChange = (value: StylingMode) => {
    logOnRejection(setStylingMode(value), "settings page: setStylingMode");
  };

  const handleToggleFastStyleShortDictations = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setFastStyleShortDictationsEnabled(event.target.checked),
      "settings page: setFastStyleShortDictationsEnabled",
    );
  };

  const handleToggleAutoStyleLoading = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disableAutoStyleLoading = !event.target.checked;
    });
  };

  return (
    <>
      <AiModelsAttentionBanner
        attentionKeyCount={attentionKeyCount}
        removedCloudModesCount={removedCloudModesCount}
      />
      <SettingGroup title={<FormattedMessage defaultMessage="Transcription" />}>
        <SettingRow
          settingKey="deepgram_api_key"
          title={<FormattedMessage defaultMessage="Deepgram API key" />}
          description={
            <FormattedMessage defaultMessage="Your own Deepgram key, for fast streaming transcription." />
          }
          icon={<ProviderLogo provider="deepgram" size={22} />}
          control={renderPersonalKeyChip(deepgramKey, apiKeysStatus)}
          onClick={() => setKeyDialog("deepgram")}
        />
        <SettingRow
          settingKey="ai_transcription"
          title={<FormattedMessage defaultMessage="AI transcription" />}
          description={
            <FormattedMessage defaultMessage="Where speech becomes text: on this computer, or through a provider." />
          }
          icon={<AudioLines size={22} strokeWidth={1.9} />}
          control={
            transcriptionAttentionState ? (
              <SelectedKeyAttentionChip state={transcriptionAttentionState} />
            ) : undefined
          }
          onClick={() => openDialog("aiTranscriptionDialogOpen")}
        />
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="Post processing" />}
      >
        <SettingRow
          settingKey="groq_api_key"
          title={<FormattedMessage defaultMessage="Groq API key" />}
          description={
            <FormattedMessage defaultMessage="Your own Groq key, for transcription and text generation." />
          }
          icon={<ProviderLogo provider="groq" size={22} />}
          control={renderPersonalKeyChip(groqKey, apiKeysStatus)}
          onClick={() => setKeyDialog("groq")}
        />
        <SettingRow
          settingKey="ai_post_processing"
          title={<FormattedMessage defaultMessage="AI post processing" />}
          description={
            <FormattedMessage defaultMessage="Cleanup and rewriting applied to dictated text before it is inserted." />
          }
          icon={<WandSparkles size={22} strokeWidth={1.9} />}
          control={
            postProcessingAttentionState ? (
              <SelectedKeyAttentionChip state={postProcessingAttentionState} />
            ) : undefined
          }
          onClick={() => openDialog("aiPostProcessingDialogOpen")}
        />
        {postProcessingMode !== "none" && (
          <SettingToggleRow
            settingKey="fast_styling_for_short_dictations"
            title={
              <FormattedMessage defaultMessage="Fast styling for short dictations" />
            }
            description={
              <FormattedMessage defaultMessage="Style a word, a sentence, or about two sentences on your device instead of waiting for the post-processing provider. Longer dictations always use the provider." />
            }
            checked={fastStyleShortDictationsEnabled}
            onChange={handleToggleFastStyleShortDictations}
          />
        )}
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Assistant" />}>
        <SettingRow
          settingKey="assistant_mode"
          title={<FormattedMessage defaultMessage="Assistant mode" />}
          description={
            <FormattedMessage defaultMessage="Ask questions, edit text, and run tools from the same place you dictate." />
          }
          icon={<Bot size={22} strokeWidth={1.9} />}
          control={
            agentAttentionState ? (
              <SelectedKeyAttentionChip state={agentAttentionState} />
            ) : (
              <Chip
                size="small"
                color="primary"
                label={<FormattedMessage defaultMessage="Beta" />}
              />
            )
          }
          // Shared with the toast the voice assistant raises when it is
          // disabled, so the two surfaces cannot disagree about where this
          // dialog lives.
          onClick={openAssistantModeDialog}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Styles" />}>
        <SettingRow
          settingKey="styling_mode"
          title={<FormattedMessage defaultMessage="Styling mode" />}
          description={
            <FormattedMessage defaultMessage="Based on app picks the style from whatever you are writing into. Manual keeps one style until you say otherwise." />
          }
          control={
            <SegmentedControl<StylingMode>
              value={stylingMode}
              onChange={handleStylingModeChange}
              options={[
                {
                  value: "app",
                  label: intl.formatMessage({
                    defaultMessage: "Based on app",
                  }),
                },
                {
                  value: "manual",
                  label: intl.formatMessage({ defaultMessage: "Manual" }),
                },
              ]}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Styling mode",
              })}
            />
          }
        />
        {availability.automatic_style_loading && (
          <SettingToggleRow
            settingKey="automatic_style_loading"
            title={
              <FormattedMessage defaultMessage="Automatic style loading" />
            }
            description={
              <FormattedMessage defaultMessage="Loads the manual style configured for the app you were in when dictation started." />
            }
            checked={!disableAutoStyleLoading}
            onChange={handleToggleAutoStyleLoading}
          />
        )}
      </SettingGroup>

      <PersonalApiKeyDialog
        provider={keyDialog ?? "groq"}
        open={keyDialog !== null}
        onClose={() => setKeyDialog(null)}
      />
    </>
  );
}

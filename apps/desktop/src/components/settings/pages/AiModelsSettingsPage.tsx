import { AudioLines, Bot, WandSparkles } from "lucide-react";
import { ProviderLogo } from "../../common/provider-logos/ProviderLogo";
import { Chip } from "@mui/material";
import type { StylingMode } from "@maus-inc/types";
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../../store";
import { getMyUserPreferences } from "../../../utils/user.utils";
import {
  setFastStyleShortDictationsEnabled,
  setStylingMode,
} from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import { getEffectiveStylingMode } from "../../../utils/feature.utils";
import { findPersonalApiKey } from "../../../utils/personal-use.utils";
import { SegmentedControl } from "../../common/SegmentedControl";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { setTipAction } from "../../onboarding/tip-actions";
import { useSettingsFocus } from "../settings-highlight";
import { useSettingsAvailability } from "../settings-availability";
import {
  PersonalApiKeyDialog,
  type PersonalApiKeyProvider,
} from "../PersonalApiKeyDialog";

const openDialog = (
  key:
    | "aiTranscriptionDialogOpen"
    | "aiPostProcessingDialogOpen"
    | "agentModeDialogOpen",
) => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

const ConfiguredChip = ({ configured }: { configured: boolean }) => (
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
    hasDeepgramKey,
    hasGroqKey,
    stylingMode,
    disableAutoStyleLoading,
    fastStyleShortDictationsEnabled,
    postProcessingMode,
  ] = useAppStore((state) => [
    findPersonalApiKey(state.settings.apiKeys, "deepgram") !== null,
    findPersonalApiKey(state.settings.apiKeys, "groq") !== null,
    getEffectiveStylingMode(state),
    state.local.disableAutoStyleLoading ?? false,
    getMyUserPreferences(state)?.fastStyleShortDictationsEnabled ?? true,
    state.settings.aiPostProcessing.mode,
  ]);

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
      <SettingGroup title={<FormattedMessage defaultMessage="Transcription" />}>
        <SettingRow
          settingKey="deepgram_api_key"
          title={<FormattedMessage defaultMessage="Deepgram API key" />}
          description={
            <FormattedMessage defaultMessage="Your own Deepgram key, for fast streaming transcription." />
          }
          icon={<ProviderLogo provider="deepgram" size={22} />}
          control={<ConfiguredChip configured={hasDeepgramKey} />}
          onClick={() => setKeyDialog("deepgram")}
        />
        <SettingRow
          settingKey="ai_transcription"
          title={<FormattedMessage defaultMessage="AI transcription" />}
          description={
            <FormattedMessage defaultMessage="Where speech becomes text: on this computer, or through a provider." />
          }
          icon={<AudioLines size={22} strokeWidth={1.9} />}
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
          control={<ConfiguredChip configured={hasGroqKey} />}
          onClick={() => setKeyDialog("groq")}
        />
        <SettingRow
          settingKey="ai_post_processing"
          title={<FormattedMessage defaultMessage="AI post processing" />}
          description={
            <FormattedMessage defaultMessage="Cleanup and rewriting applied to dictated text before it is inserted." />
          }
          icon={<WandSparkles size={22} strokeWidth={1.9} />}
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
            <Chip
              size="small"
              color="primary"
              label={<FormattedMessage defaultMessage="Beta" />}
            />
          }
          onClick={() => openDialog("agentModeDialogOpen")}
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

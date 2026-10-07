import {
  AutoAwesomeOutlined,
  AutoFixHighOutlined,
  GraphicEqOutlined,
  KeyOutlined,
} from "@mui/icons-material";
import { Chip } from "@mui/material";
import type { StylingMode } from "@maus-inc/types";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../../store";
import { setStylingMode } from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import { getEffectiveStylingMode } from "../../../utils/feature.utils";
import { findPersonalApiKey } from "../../../utils/personal-use.utils";
import { TipCard } from "../../onboarding/TipCard";
import { SegmentedControl } from "../../common/SegmentedControl";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
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
  const [keyDialog, setKeyDialog] = useState<PersonalApiKeyProvider | null>(
    null,
  );

  const [hasDeepgramKey, hasGroqKey, stylingMode, disableAutoStyleLoading] =
    useAppStore((state) => [
      findPersonalApiKey(state.settings.apiKeys, "deepgram") !== null,
      findPersonalApiKey(state.settings.apiKeys, "groq") !== null,
      getEffectiveStylingMode(state),
      state.local.disableAutoStyleLoading ?? false,
    ]);

  const handleStylingModeChange = (value: StylingMode) => {
    logOnRejection(setStylingMode(value), "settings page: setStylingMode");
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
      <TipCard id="generative-provider" />

      <SettingGroup title={<FormattedMessage defaultMessage="Transcription" />}>
        <SettingRow
          settingKey="deepgram_api_key"
          title={<FormattedMessage defaultMessage="Deepgram API key" />}
          description={
            <FormattedMessage defaultMessage="Your own Deepgram key, for fast streaming transcription." />
          }
          icon={<KeyOutlined />}
          control={<ConfiguredChip configured={hasDeepgramKey} />}
          onClick={() => setKeyDialog("deepgram")}
        />
        <SettingRow
          settingKey="ai_transcription"
          title={<FormattedMessage defaultMessage="AI transcription" />}
          description={
            <FormattedMessage defaultMessage="Where speech becomes text: on this computer, or through a provider." />
          }
          icon={<GraphicEqOutlined />}
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
          icon={<KeyOutlined />}
          control={<ConfiguredChip configured={hasGroqKey} />}
          onClick={() => setKeyDialog("groq")}
        />
        <SettingRow
          settingKey="ai_post_processing"
          title={<FormattedMessage defaultMessage="AI post processing" />}
          description={
            <FormattedMessage defaultMessage="Cleanup and rewriting applied to dictated text before it is inserted." />
          }
          icon={<AutoFixHighOutlined />}
          onClick={() => openDialog("aiPostProcessingDialogOpen")}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Assistant" />}>
        <SettingRow
          settingKey="assistant_mode"
          title={<FormattedMessage defaultMessage="Assistant mode" />}
          description={
            <FormattedMessage defaultMessage="Ask questions, edit text, and run tools from the same place you dictate." />
          }
          icon={<AutoAwesomeOutlined />}
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

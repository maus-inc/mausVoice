import { AudioLines, Bot, WandSparkles } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";
import { useAppStore } from "../../../store";
import type { AppState } from "../../../state/app.state";
import type { SettingsApiKey } from "../../../state/settings.state";
import {
  getProviderDisplayName,
  getProviderLocation,
  type ProviderLocation,
} from "../api-key-provider-config";
import type { ApiKeyListContext } from "../ApiKeyList";
import {
  LOCAL_MODEL_OPTIONS,
  normalizeLocalWhisperModel,
} from "../../../utils/local-transcription.utils";
import {
  getAgentModePrefs,
  getEffectiveAgentMode,
  getEffectivePostProcessingMode,
  getEffectiveTranscriptionMode,
  getGenerativePrefs,
  getTranscriptionPrefs,
} from "../../../utils/user.utils";
import { SettingGroup, SettingGroupLink } from "../SettingRow";
import { SettingSummaryRow } from "../SettingSummaryRow";
import { settingsPagePath } from "../settings-routes";

/**
 * The key row a selection points at, unresolved.
 *
 * The row itself is what a summary needs: it carries the provider *and* the base
 * URL, and the base URL is half of where the work actually happens.
 */
const apiKeyOf = (
  state: AppState,
  keyId: string | null,
): SettingsApiKey | null =>
  (keyId ? state.apiKeyById[keyId] : undefined) ?? null;

/**
 * One model row's state, resolved to the words the row shows.
 *
 * `attention` is set only where the app knows the choice is unfinished: a
 * provider mode with no provider selected, or a local model whose status has
 * loaded and says it is not on disk. An unloaded status says nothing, so it
 * does not raise one.
 */
type ModelSummary = {
  /** The model, provider or state the row names. */
  model: string;
  /** Where the work happens, when that is knowable. */
  location: string | null;
  attention: boolean;
};

/**
 * The models card: which model answers each of the three questions the app asks
 * of one, and where that model runs.
 *
 * The rows are the settings chassis rather than a shape of their own, so they
 * hover, focus and align exactly like the rows they summarize; the *label* of
 * each is the name the AI models page gives the same setting, and the row's own
 * line carries the answer. Two names for one setting is how a summary and the
 * page behind it start disagreeing.
 */
export const YourModelsCard = () => {
  const intl = useIntl();

  const [
    transcriptionMode,
    transcriptionModel,
    transcriptionReady,
    transcriptionStatusesLoaded,
    transcriptionKey,
    transcriptionDispatches,
  ] = useAppStore((state) => {
    const config = state.settings.aiTranscription;
    const model = normalizeLocalWhisperModel(config.modelSize);
    const status = config.localModelManagement.modelStatuses[model];
    return [
      getEffectiveTranscriptionMode(state),
      model,
      Boolean(status?.downloaded && status?.valid),
      config.localModelManagement.modelStatusesLoaded,
      apiKeyOf(state, config.selectedApiKeyId),
      // What the app would actually dispatch with, which is not the same thing
      // as the mode that is selected: a key row with no credential in it falls
      // back at runtime, and a summary of the selection would describe a
      // request the app never makes.
      getTranscriptionPrefs(state).mode === "api",
    ] as const;
  });

  const [postProcessingMode, postProcessingKey, postProcessingDispatches] =
    useAppStore(
      (state) =>
        [
          getEffectivePostProcessingMode(state),
          apiKeyOf(state, state.settings.aiPostProcessing.selectedApiKeyId),
          getGenerativePrefs(state).mode === "api",
        ] as const,
    );

  const [agentMode, agentKey, agentDispatches] = useAppStore(
    (state) =>
      [
        getEffectiveAgentMode(state),
        apiKeyOf(state, state.settings.agentMode.selectedApiKeyId),
        getAgentModePrefs(state).mode === "api",
      ] as const,
  );

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

  // Where the work happens, in the app's own words: the local engine's row says
  // "On this computer" for the same reason an endpoint on loopback does.
  const locationWord = (location: ProviderLocation): string | null => {
    if (location === "local") {
      return onThisComputer;
    }
    if (location === "cloud") {
      return cloud;
    }
    // A base URL that cannot be read tells us nothing about where the bytes go,
    // so the row reports the provider and stops rather than guessing.
    return null;
  };

  const apiRowOf = (
    key: SettingsApiKey | null,
    context: ApiKeyListContext,
    dispatches: boolean,
  ): ModelSummary => {
    // A selection the runtime will not use is not a configured provider, and
    // "Cloud" beside it would describe a request the app never makes. The page
    // that owns the setting is one click away and names the missing piece.
    if (!key || !dispatches) {
      return { model: notConfigured, location: null, attention: true };
    }
    const name = getProviderDisplayName(key.provider, context);
    // A provider this build has no entry for is the same answer: nothing here
    // can say where the work happens, so the row does not say anything.
    if (!name) {
      return { model: notConfigured, location: null, attention: true };
    }
    return {
      model: name,
      location: locationWord(getProviderLocation(key.provider, key.baseUrl)),
      attention: false,
    };
  };

  // A loaded status that says "not on disk" is the only thing that makes the
  // missing-model word true; before the statuses load, the app does not know.
  const localModelMissing = transcriptionStatusesLoaded && !transcriptionReady;
  // The catalogue name when this build knows the model, and the raw id when it
  // does not, so a model added ahead of its entry still names itself.
  const localModelName = localModel
    ? intl.formatMessage(localModel.label)
    : transcriptionModel;

  const transcriptionSummary: ModelSummary =
    transcriptionMode === "local"
      ? {
          model: localModelMissing
            ? intl.formatMessage({ defaultMessage: "Not downloaded yet" })
            : localModelName,
          location: onThisComputer,
          attention: localModelMissing,
        }
      : apiRowOf(transcriptionKey, "transcription", transcriptionDispatches);

  const postProcessingSummary: ModelSummary =
    postProcessingMode === "none"
      ? { model: off, location: null, attention: false }
      : apiRowOf(
          postProcessingKey,
          "post-processing",
          postProcessingDispatches,
        );

  const agentSummary: ModelSummary =
    agentMode === "none"
      ? { model: off, location: null, attention: false }
      : apiRowOf(agentKey, "post-processing", agentDispatches);

  return (
    <SettingGroup
      title={<FormattedMessage defaultMessage="Your models" />}
      action={
        <SettingGroupLink to={settingsPagePath("ai-models")}>
          <FormattedMessage defaultMessage="Manage models" />
        </SettingGroupLink>
      }
    >
      <SettingSummaryRow
        linksTo="ai_transcription"
        icon={<AudioLines size={20} strokeWidth={1.9} />}
        subtitle={<FormattedMessage defaultMessage="AI transcription" />}
        title={transcriptionSummary.model}
        value={transcriptionSummary.location}
        attention={transcriptionSummary.attention}
      />
      <SettingSummaryRow
        linksTo="ai_post_processing"
        icon={<WandSparkles size={20} strokeWidth={1.9} />}
        subtitle={<FormattedMessage defaultMessage="AI post processing" />}
        title={postProcessingSummary.model}
        value={postProcessingSummary.location}
        attention={postProcessingSummary.attention}
      />
      <SettingSummaryRow
        linksTo="assistant_mode"
        icon={<Bot size={20} strokeWidth={1.9} />}
        subtitle={<FormattedMessage defaultMessage="Assistant mode" />}
        title={agentSummary.model}
        value={agentSummary.location}
        attention={agentSummary.attention}
      />
    </SettingGroup>
  );
};

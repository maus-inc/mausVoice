import { AIAgentModeDialog } from "../settings/AIAgentModeDialog";
import { AIPostProcessingDialog } from "../settings/AIPostProcessingDialog";
import { AITranscriptionDialog } from "../settings/AITranscriptionDialog";
import { AppKeybindingsDialog } from "../settings/AppKeybindingsDialog";
import { AudioDialog } from "../settings/AudioDialog";
import { ClearLocalDataDialog } from "../settings/ClearLocalDataDialog";
import { DeleteAccountDialog } from "../settings/DeleteAccountDialog";
import { DictationLanguageDialog } from "../settings/DictationLanguageDialog";
import { DiagnosticsDialog } from "../settings/DiagnosticsDialog";
import { ElevationDeclinedDialog } from "./ElevationDeclinedDialog";
import { MicrophoneDialog } from "../settings/MicrophoneDialog";
import { MultiDeviceDialog } from "../settings/MultiDeviceDialog";
import { MoreSettingsDialog } from "../settings/MoreSettingsDialog";
import { ProfileDialog } from "../settings/ProfileDialog";
import { ShortcutsDialog } from "../settings/ShortcutsDialog";
import { ToneEditorDialog } from "../tones/ToneEditorDialog";
import { RetranscribeDialog } from "../transcriptions/RetranscribeDialog";

export const RootDialogs = () => {
  return (
    <>
      <RetranscribeDialog />
      <ToneEditorDialog />
      <AITranscriptionDialog />
      <AIPostProcessingDialog />
      <AIAgentModeDialog />
      <ProfileDialog />
      <MicrophoneDialog />
      <AudioDialog />
      <ShortcutsDialog />
      <ClearLocalDataDialog />
      <DeleteAccountDialog />
      <MoreSettingsDialog />
      <MultiDeviceDialog />
      <DictationLanguageDialog />
      <AppKeybindingsDialog />
      <DiagnosticsDialog />
      <ElevationDeclinedDialog />
    </>
  );
};

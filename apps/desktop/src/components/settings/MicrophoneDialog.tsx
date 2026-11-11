import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { useCallback, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import {
  setKeepMicrophoneReady,
  setMicrophoneLingerMs,
  setMicrophonePrerollSeconds,
} from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { useAppStore } from "../../store";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import { SettingSection } from "../common/SettingSection";
import {
  DEFAULT_MICROPHONE_LINGER_MS,
  describeHeldState,
  isSelectedDeviceBluetooth,
} from "../../utils/microphone-readiness.utils";
import type { MicrophoneOption } from "../microphone/MicrophoneSelector";
import { MicrophoneTester } from "../microphone/MicrophoneTester";
import { duration } from "../../styles/motion";
import { useScrollEdges, type ScrollEdges } from "./use-scroll-edges";
import { useMicrophoneDialogSave } from "./use-microphone-dialog-save";
import { PreferredMicrophoneSection } from "./PreferredMicrophoneSection";
import { KeepReadySection } from "./KeepReadySection";
import { LingerSection } from "./LingerSection";
import { savePreference } from "./save-preference";

/**
 * Fades that mark an edge of the scrollable content.
 *
 * `pointerEvents: "none"` because a gradient is decoration: it must never eat a
 * click meant for the control underneath. The duration comes from
 * `styles/motion` rather than being written here: a hard-coded duration is a
 * defect in this codebase, and two of them would drift the moment the token
 * changed.
 *
 * Under `prefers-reduced-motion` the transition is dropped rather than the fade
 * itself. The fade carries no motion, and removing it would take away the only
 * cue that text is cut off.
 */
const ScrollEdgeFades = ({ edges }: { edges: ScrollEdges }) => {
  // `vars` is the CSS-variable theme and is absent wherever the component is
  // rendered without a provider -- every jsdom test of this dialog. Falling
  // back to the resolved palette keeps the gradient a real colour there instead
  // of throwing on an undefined theme.
  const gradient = (direction: "to bottom" | "to top") => (theme: Theme) => {
    const paper = theme.vars?.palette.background.paper;
    return `linear-gradient(${direction}, ${paper ?? theme.palette.background.paper}, transparent)`;
  };

  return (
    <>
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          top: 0,
          left: 1,
          right: 1,
          height: 18,
          pointerEvents: "none",
          opacity: edges.top ? 1 : 0,
          transition: `opacity ${duration.fast * 1000}ms ease`,
          background: gradient("to bottom"),
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          bottom: 0,
          left: 1,
          right: 1,
          height: 18,
          pointerEvents: "none",
          opacity: edges.bottom ? 1 : 0,
          transition: `opacity ${duration.fast * 1000}ms ease`,
          background: gradient("to top"),
        }}
      />
    </>
  );
};

/**
 * The microphone settings dialog.
 *
 * This was a single 300-line function with a cyclomatic complexity of 19. The
 * three sections it renders were already distinct `<Stack>` blocks separated by
 * `<Divider>`s, and its save state was already a unit, so both were lifted out
 * along boundaries the code had drawn: `useMicrophoneDialogSave` for the state,
 * `PreferredMicrophoneSection`/`KeepReadySection`/`LingerSection` for the
 * markup. What is left is the wiring, which is what a container should be.
 *
 * The reads stay here rather than moving into the sections, because all three
 * sections read from the same preferences and moving the reads down would mean
 * three subscriptions to the same values.
 */
export const MicrophoneDialog = () => {
  const open = useAppStore((state) => state.settings.microphoneDialogOpen);
  const savedPreference = useMyPreferredMicrophone();
  const intl = useIntl();
  const keepReady = useAppStore(
    (state) => state.userPrefs?.keepMicrophoneReady === true,
  );
  const prerollSeconds = useAppStore(
    (state) => state.userPrefs?.microphonePrerollSeconds ?? 0.5,
  );
  const microphoneHeld = useAppStore((state) => state.settings.microphoneHeld);
  const heldState = describeHeldState(microphoneHeld);
  const lingerMs = useAppStore(
    (state) => state.userPrefs?.microphoneLingerMs ?? 0,
  );
  const lingerOn = lingerMs > 0;
  // A zero pre-roll is a deliberate choice: the user asked for a recording that
  // starts exactly at the press. The slider therefore stays rendered at zero --
  // it is the only control that sets this value, so hiding it at the one value a
  // drag can reach would strand the user with pre-roll off and no way back.
  // `prerollOn` only chooses the caption, which must not describe a window that
  // does not exist.
  const prerollOn = prerollSeconds > 0;

  const {
    selected,
    selectDevice,
    hasChanges,
    saving,
    saveError,
    save,
    requestClose,
    contentRef,
    feedbackRef,
  } = useMicrophoneDialogSave({ open, savedPreference });

  /**
   * The device list the selector loaded, so the keep-ready warning can ask the
   * backend's own verdict instead of guessing from a name.
   */
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);
  const handleDevicesKnown = useCallback(
    (next: MicrophoneOption[]) => setDevices(next),
    [],
  );
  // `undefined` when the selected device is not in the list -- unplugged, or on
  // a host that is not enumerating -- which is what lets the label fallback run.
  const microphoneBluetooth = devices.find(
    (device) => device.value === selected,
  )?.bluetooth;

  // The dialog is taller than a short window, and the content is clipped
  // mid-sentence with nothing to say so. `contentNode` mirrors `contentRef` in
  // state because the hook needs the element itself, and a ref's `.current` is
  // not reactive: the first render would measure nothing.
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const scrollEdges = useScrollEdges(contentNode, open);

  // Holding the microphone open is only a bargain on the built-in device.
  // Bluetooth is a shared half-duplex channel: while anything captures, macOS
  // drops the headset from A2DP to the hands-free profile, so playback becomes
  // call quality and the headset's battery drains faster for as long as the
  // hold lasts. The switch's own copy promises the indicator and nothing else,
  // which is true and not the whole cost.
  //
  // The selection, not the saved preference: a headset picked but not yet saved
  // is still the device the next press opens, so the warning has to follow the
  // control rather than the row in the database. The flag comes from the
  // selector's device list because the backend is the one that decided it; the
  // label is the fallback for a stored device that is not in the list right now.
  const bluetoothWarning =
    keepReady &&
    isSelectedDeviceBluetooth({
      label: selected,
      bluetoothFlag: microphoneBluetooth,
    });

  const prerollLabel = intl.formatMessage({
    defaultMessage: "Audio kept before the press",
  });
  const lingerLabel = intl.formatMessage({
    defaultMessage: "How long to stay open after each dictation",
  });
  const secondsFormat = useCallback(
    (choice: number) =>
      intl.formatMessage(
        { defaultMessage: "{seconds} s" },
        {
          seconds: choice / 1000,
        },
      ),
    [intl],
  );

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      fullWidth
      maxWidth="sm"
      // The fades are positioned against this box, so it has to be the
      // containing block for them.
      sx={{ "& .MuiDialog-paper": { position: "relative" } }}
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Microphone settings" />
      </DialogTitle>
      {/*
        The fades live in this wrapper, not inside `DialogContent`: the content
        scrolls, so a fade inside it would scroll away from the edge it marks.
        Sizing to the content's own box also means no hard-coded offsets that
        would drift the moment the title or the actions bar changes height.
      */}
      <Box sx={{ position: "relative", display: "flex", minHeight: 0 }}>
        <DialogContent
          dividers
          ref={(node: HTMLDivElement | null) => {
            contentRef.current = node;
            setContentNode(node);
          }}
        >
          <Stack spacing={3} sx={{ paddingTop: 0.5 }}>
            <PreferredMicrophoneSection
              selected={selected}
              saving={saving}
              saveError={saveError}
              onSelect={selectDevice}
              onDevicesKnown={handleDevicesKnown}
              feedbackRef={feedbackRef}
            />

            <Divider />

            <KeepReadySection
              keepReady={keepReady}
              heldState={heldState}
              bluetoothWarning={bluetoothWarning}
              prerollSeconds={prerollSeconds}
              prerollOn={prerollOn}
              prerollLabel={prerollLabel}
              onKeepReadyChange={(checked) =>
                savePreference(setKeepMicrophoneReady(checked))
              }
              onPrerollCommit={(value) =>
                savePreference(setMicrophonePrerollSeconds(value))
              }
            />

            <Divider />

            <LingerSection
              keepReady={keepReady}
              lingerOn={lingerOn}
              lingerMs={lingerMs}
              lingerLabel={lingerLabel}
              secondsFormat={secondsFormat}
              onLingerChange={(checked) =>
                savePreference(
                  setMicrophoneLingerMs(
                    checked ? DEFAULT_MICROPHONE_LINGER_MS : 0,
                  ),
                )
              }
              onDurationChange={(milliseconds) =>
                savePreference(setMicrophoneLingerMs(milliseconds))
              }
            />

            <Divider />

            <Stack spacing={1.5}>
              <SettingSection
                title={
                  <FormattedMessage defaultMessage="Test your microphone" />
                }
                description={
                  <FormattedMessage defaultMessage="Start a short test to see live audio levels and play back what was recorded." />
                }
              />
              <MicrophoneTester preferredMicrophone={selected ?? null} />
            </Stack>
          </Stack>
        </DialogContent>
        {/*
          Inside the wrapper and above the content, so each fade hugs its own
          edge of the scroll area. They are always rendered and faded in by
          opacity: mounting them on demand would work, but an edge that appears
          and disappears under the cursor is worse than a 150 ms cross-fade.
        */}
        <ScrollEdgeFades edges={scrollEdges} />
      </Box>
      <DialogActions>
        <Button onClick={requestClose} disabled={saving}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
        <Button
          onClick={save}
          disabled={!hasChanges || saving}
          aria-busy={saving || undefined}
          variant="contained"
        >
          {saving ? (
            <BusyButtonLabel>
              <FormattedMessage defaultMessage="Save changes" />
            </BusyButtonLabel>
          ) : (
            <FormattedMessage defaultMessage="Save changes" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

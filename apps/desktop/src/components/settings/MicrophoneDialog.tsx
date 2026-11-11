import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { Nullable } from "@maus-inc/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { toast } from "sonner";
import {
  setKeepMicrophoneReady,
  setMicrophoneLingerMs,
  setMicrophonePrerollSeconds,
  setPreferredMicrophone,
} from "../../actions/user.actions";
import { useMyPreferredMicrophone } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";
import { BusyButtonLabel } from "../common/BusyButtonLabel";
import {
  MicrophoneSelector,
  type MicrophoneOption,
} from "../microphone/MicrophoneSelector";
import { useScrollEdges, type ScrollEdges } from "./use-scroll-edges";
import { MicrophoneTester } from "../microphone/MicrophoneTester";
import { ElasticSlider } from "../common/ElasticSlider";
import { Reveal } from "../common/Reveal";
import { SegmentedControl } from "../common/SegmentedControl";
import {
  DEFAULT_MICROPHONE_LINGER_MS,
  MAX_MICROPHONE_PREROLL_SECONDS,
  describeHeldState,
  isSelectedDeviceBluetooth,
  lingerChoices,
  nearestLingerChoice,
} from "../../utils/microphone-readiness.utils";

/**
 * Scrolls a save result into view, without stealing the user's place.
 *
 * Two rules, and both are why this is a function rather than five inline
 * branches inside the component's effect:
 *
 * - Never move the viewport while the user is working inside the dialog. A save
 *   is often still in flight when they start typing into the tester, and
 *   scrolling out from under them costs more than the alert it reveals. The
 *   alert still announces itself, so nothing is lost by staying put.
 * - A feedback box taller than the container is aligned to its top rather than
 *   its bottom, because aligning the bottom would hide the first line of the
 *   message -- the part that says what went wrong.
 */
const revealFeedback = (
  content: HTMLElement | null,
  feedback: HTMLElement | null,
): void => {
  if (!content || !feedback) return;
  if (content.contains(document.activeElement)) return;
  const containerRect = content.getBoundingClientRect();
  const errorRect = feedback.getBoundingClientRect();
  if (
    errorRect.top < containerRect.top ||
    errorRect.height > containerRect.height
  ) {
    content.scrollTop += errorRect.top - containerRect.top;
    return;
  }
  if (errorRect.bottom > containerRect.bottom) {
    content.scrollTop += errorRect.bottom - containerRect.bottom + 8;
  }
};

/**
 * Fire a preference write from a change handler.
 *
 * The write is asynchronous and `updateUserPreferences` already raises its own
 * error toast, so there is nothing to await and nothing to report here. It is
 * deliberately not `void x().catch(() => {})`, which is the pattern elsewhere in
 * settings: that swallows the rejection, and these writes do not need a silent
 * catch because the action never rejects -- it reports through the snackbar and
 * resolves. `void` only says the promise is intentionally not awaited, which is
 * the part a reader needs.
 *
 * Clamped and rounded inside the action, so a switch or slider that fires twice
 * with the same value is harmless.
 */
const savePreference = (write: Promise<void>): void => {
  void write;
};

/**
 * Fades that mark an edge of the scrollable content.
 *
 * `pointerEvents: "none"` because a gradient is decoration: it must never eat a
 * click meant for the control underneath. Under `prefers-reduced-motion` the
 * transition is dropped rather than the fade itself -- the fade carries no
 * motion, and removing it would take away the only cue that text is cut off.
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
          transition: "opacity 150ms ease",
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
          transition: "opacity 150ms ease",
          background: gradient("to top"),
        }}
      />
    </>
  );
};

/**
 * The three status lines of the keep-ready section, one per state.
 *
 * Each carries its own `defaultMessage` at its own call so the i18n extractor
 * still sees three distinct messages; a lookup table would collapse them into
 * keys it cannot read and they would drop out of every catalogue.
 */
const HeldStateLine = ({
  state,
}: {
  readonly state: ReturnType<typeof describeHeldState>;
}) => {
  if (state === "held") {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="Held open now." />
      </Typography>
    );
  }
  if (state === "not_held") {
    return (
      <Typography variant="body2" color="text.secondary">
        <FormattedMessage defaultMessage="Not holding the microphone yet, so a press still has to open it. The setting applies as soon as the device opens." />
      </Typography>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      <FormattedMessage defaultMessage="Checking the microphone..." />
    </Typography>
  );
};

/**
 * What the pre-roll slider does at its current value.
 *
 * Two messages rather than one with a suffix: at zero the setting is genuinely
 * off, not small, and saying "keeps a little" would describe a window that does
 * not exist.
 */
const PrerollCaption = ({ on }: { readonly on: boolean }) => (
  <Typography variant="caption" color="text.secondary">
    {on ? (
      <FormattedMessage defaultMessage="How much speech to keep from just before you press, so a word you start early is not cut off." />
    ) : (
      <FormattedMessage defaultMessage="Nothing is kept from before the press, so the first word is captured only once recording starts." />
    )}
  </Typography>
);

/**
 * Why the linger switch reads the way it does.
 *
 * When keep-ready is on the switch is on and disabled, so the caption has to say
 * why rather than describe a window that the hold has already superseded.
 */
const LingerCaption = ({ keepReady }: { readonly keepReady: boolean }) => (
  <Typography variant="body2" color="text.secondary">
    {keepReady ? (
      <FormattedMessage defaultMessage="Already on, because the microphone is kept ready." />
    ) : (
      <FormattedMessage defaultMessage="Keeps the microphone open for a few seconds after each recording, so a second dictation starts instantly. Your system shows its microphone-in-use indicator for that time." />
    )}
  </Typography>
);

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

  const [selected, setSelected] = useState<Nullable<string>>(savedPreference);

  /**
   * The device list the selector loaded, so the keep-ready warning can ask the
   * backend's own verdict instead of guessing from a name.
   */
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);
  const handleDevicesKnown = useCallback(
    (next: MicrophoneOption[]) => setDevices(next),
    [],
  );
  // `undefined` when the selected device is not in the list -- unplugged, or on a
  // host that is not enumerating -- which is what lets the label fallback run.
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
  // which is true and not the whole cost. Named here so the warning is tied to
  // the control it is about rather than to a serialized message.
  // The selection, not the saved preference: a headset picked but not yet saved
  // is still the device the next press opens, so the warning has to follow the
  // control rather than the row in the database.
  //
  // The flag comes from the selector's device list, because the backend is the
  // one that decided it; the label is the fallback for a stored device that is
  // not in the list right now (unplugged). `microphoneBluetooth` carries that
  // through `MicrophoneSelector`'s `onDevicesKnown`.
  const bluetoothWarning =
    keepReady &&
    isSelectedDeviceBluetooth({
      label: selected,
      bluetoothFlag: microphoneBluetooth,
    });
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [saveError, setSaveError] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Only the error can move the view. The success case is a toast, and a toast is
  // outside the dialog's scroll container, so there is nothing here for it to
  // scroll to -- and no live region to fill, because sonner announces it.
  useLayoutEffect(() => {
    if (!saveError) return;
    revealFeedback(contentRef.current, feedbackRef.current);
  }, [saveError]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(savedPreference);
    setHasChanges(false);
    setSaveError(false);
  }, [open, savedPreference]);

  const handleSelectionChange = useCallback(
    (next: Nullable<string>) => {
      setSelected(next ?? null);
      setHasChanges((next ?? null) !== (savedPreference ?? null));
      setSaveError(false);
    },
    [savedPreference],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges || saving || saveInFlight.current) {
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setSaveError(false);

    try {
      await setPreferredMicrophone(selected ?? null);
      setHasChanges(false);
      // Deliberately not paired with any in-dialog confirmation: sonner's toast
      // is the announcement, and rendering the same sentence in a second live
      // region makes a screen reader say it twice.
      toast.success(
        intl.formatMessage({ defaultMessage: "Preference saved." }),
        { duration: 5000 },
      );
    } catch {
      setSaveError(true);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [hasChanges, intl, saving, selected]);

  const handleClose = useCallback(() => {
    if (saveInFlight.current) return;
    produceAppState((draft) => {
      draft.settings.microphoneDialogOpen = false;
    });
  }, []);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
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
            <Stack spacing={1.5}>
              <SettingSection
                title={
                  <FormattedMessage defaultMessage="Preferred microphone" />
                }
                description={
                  <FormattedMessage defaultMessage="Choose which microphone mausVoice should use when recording. Automatic picks the best available device each time." />
                }
                sx={{ pb: 0.5 }}
              />
              <MicrophoneSelector
                value={selected ?? null}
                onChange={handleSelectionChange}
                disabled={saving}
                onDevicesKnown={handleDevicesKnown}
              />
              {saveError && (
                <Alert ref={feedbackRef} severity="error">
                  <FormattedMessage defaultMessage="Failed to save microphone preference. Please try again." />
                </Alert>
              )}
            </Stack>

            <Divider />

            <Stack spacing={1.5}>
              <FormControlLabel
                control={
                  <Switch
                    checked={keepReady}
                    onChange={(event) =>
                      savePreference(
                        setKeepMicrophoneReady(event.target.checked),
                      )
                    }
                  />
                }
                label={
                  <FormattedMessage defaultMessage="Keep the microphone ready" />
                }
              />
              <Typography variant="body2" color="text.secondary">
                <FormattedMessage defaultMessage="Start dictating instantly by opening the microphone ahead of time. Your system shows its microphone-in-use indicator the whole time this is on." />
              </Typography>
              <Reveal show={keepReady}>
                <HeldStateLine state={heldState} />
              </Reveal>
              {/* The switch's own copy promises the microphone indicator. On a
                Bluetooth headset the real cost is larger and invisible: the
                link drops to the hands-free profile, so playback becomes call
                quality and the headset's battery drains for as long as the hold
                lasts. Saying so under the switch, not in a toast, because it is
                a standing property of the setting rather than an event. */}
              <Reveal show={bluetoothWarning}>
                <Alert
                  severity="warning"
                  icon={false}
                  sx={{ alignItems: "center", py: 0.5 }}
                >
                  <Typography variant="body2">
                    <FormattedMessage defaultMessage="This is a Bluetooth microphone. While it is held, your headset switches to its call profile, so audio you play will sound like a phone call and its battery will drain faster." />
                  </Typography>
                </Alert>
              </Reveal>
              {/* Offered outside the keep-ready branch because it is not a
                keep-ready setting. The pre-roll is what the next press keeps
                from before it, which matters most when the device is opened at
                that press: hiding it here left the control unreachable for
                exactly the case where it does the most work. */}
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  <FormattedMessage defaultMessage="Audio kept before the press" />
                </Typography>
                <ElasticSlider
                  value={prerollSeconds}
                  min={0}
                  max={MAX_MICROPHONE_PREROLL_SECONDS}
                  step={0.1}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(value) => `${value.toFixed(1)} s`}
                  ariaLabel={intl.formatMessage({
                    defaultMessage: "Audio kept before the press",
                  })}
                  onCommit={(value) => setMicrophonePrerollSeconds(value)}
                />
                <PrerollCaption on={prerollOn} />
              </Stack>
            </Stack>

            <Divider />

            <Stack spacing={1.5}>
              <FormControlLabel
                control={
                  <Switch
                    // The effective state, not the stored one. Keep-ready holds the
                    // device forever, so the linger window is on whatever its own
                    // preference says; showing the stored value left a disabled
                    // switch reading "off" directly above a caption that said it was
                    // already on.
                    checked={keepReady || lingerOn}
                    // `aria-disabled`, not `disabled`. A disabled control leaves
                    // the tab order entirely, and the one thing a keyboard user
                    // needs here is to reach this switch and hear the caption
                    // below that says why it is on: keep-ready already holds the
                    // device, so this setting has nothing left to add. Removing
                    // it from the tab order made the reason unreachable for
                    // exactly the users who cannot see the caption underneath.
                    // The handler below is what makes it inert.
                    //
                    // On the inner `input`, not the wrapper: a bare
                    // `aria-disabled` on the component lands on the `<span>`
                    // wrapper, which is not the node a screen reader reaches when
                    // the switch is focused, so the state would be announced for
                    // nobody. `slotProps.input` is the MUI v7 spelling; the
                    // deprecated `inputProps` is silently dropped in v9 (it
                    // renders as a literal `inputprops="[object Object]"`
                    // attribute on the wrapper), which is how the first attempt
                    // failed without an error.
                    // Both slots, and the second is not redundant. `input` is
                    // the node a screen reader reaches; `switchBase` is the span
                    // the theme can style and the only one an adjacent-sibling
                    // rule can dim the track from. A CSS child selector cannot
                    // reach up from the input to its wrapper, so a style keyed on
                    // the input alone silently did nothing.
                    slotProps={{
                      input: { "aria-disabled": keepReady || undefined },
                      switchBase: { "aria-disabled": keepReady || undefined },
                    }}
                    onChange={(event) => {
                      if (keepReady) {
                        return;
                      }
                      savePreference(
                        setMicrophoneLingerMs(
                          event.target.checked
                            ? DEFAULT_MICROPHONE_LINGER_MS
                            : 0,
                        ),
                      );
                    }}
                  />
                }
                label={
                  <FormattedMessage defaultMessage="Stay ready after a dictation" />
                }
              />
              <LingerCaption keepReady={keepReady} />
              {/* Only while the switch is the one in charge. Showing a duration
                under a switch that keep-ready has overridden would offer a
                choice the app is not listening to. */}
              <Reveal show={!keepReady && lingerOn}>
                <Stack spacing={0.5}>
                  <Typography variant="caption" color="text.secondary">
                    <FormattedMessage defaultMessage="How long to stay open after each dictation" />
                  </Typography>
                  <SegmentedControl
                    value={String(nearestLingerChoice(lingerMs))}
                    options={lingerChoices().map((choice) => ({
                      value: String(choice),
                      label: intl.formatMessage(
                        {
                          defaultMessage: "{seconds} s",
                        },
                        { seconds: choice / 1000 },
                      ),
                    }))}
                    onChange={(next) =>
                      savePreference(setMicrophoneLingerMs(Number(next)))
                    }
                    ariaLabel={intl.formatMessage({
                      defaultMessage:
                        "How long to stay open after each dictation",
                    })}
                  />
                </Stack>
              </Reveal>
            </Stack>

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
        <Button onClick={handleClose} disabled={saving}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
        <Button
          onClick={handleSave}
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

/** Pill-adjacent & app-bound demos — faithful recreations (see registry notes). */
import EditIcon from "@mui/icons-material/Edit";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { MenuPopoverBuilder } from "@desktop/components/common/MenuPopover";
import { AssistantPanel, type PanelSize } from "../recreated/assistant-panel";
import { AudioPlayerPillPreview } from "../recreated/audio-player-pill";
import { NativePillCanvas, type PillPhase } from "../recreated/native-pill";
import { MicrophoneSelectorPreview, MicrophoneTesterPreview, TONE_FIXTURES, ToneSelectPreview } from "../recreated/slices";
import { PERMISSION_FIXTURES, ToolPermissionPromptPreview } from "../recreated/tool-permission";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const NativePillDemo = () => {
  const [phase, setPhase] = useState<PillPhase>("recording");
  const [hovered, setHovered] = useState(true);
  return (
    <>
      <DemoSection title="Dictation pill — all phases" hint="Canvas recreation from rust_macos_pill constants. Window 200×86, pill 48×6 → 120×32, radius ≤ 16, bg black 0.6→0.92, white 0.3 border.">
        <Matrix>
          {(["idle", "recording", "loading", "paused"] as PillPhase[]).map((p) => (
            <State key={p} label={p} dark>
              <NativePillCanvas phase={p} hovered={p === "idle" ? true : undefined} width={200} />
            </State>
          ))}
        </Matrix>
      </DemoSection>
      <DemoSection title="Interactive" hint="Phase + hover drive the expand spring (stiffness 200). Reduced motion renders the rest frame statically.">
        <TryIt>switch phases — the pill breathes between collapsed and expanded.</TryIt>
        <Matrix>
          <State label="live" dark wide>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              {(["idle", "recording", "loading", "paused"] as PillPhase[]).map((p) => (
                <Button key={p} variant={phase === p ? "blue" : "flat"} onClick={() => setPhase(p)}>
                  {p}
                </Button>
              ))}
              <Button variant={hovered ? "blue" : "flat"} onClick={() => setHovered((h) => !h)}>
                hover {hovered ? "on" : "off"}
              </Button>
            </Stack>
            <NativePillCanvas phase={phase} hovered={hovered} width={240} />
          </State>
        </Matrix>
      </DemoSection>
    </>
  );
};

export const AssistantPanelDemo = () => {
  const [size, setSize] = useState<PanelSize>("compact");
  return (
    <>
      <DemoSection title="Panel sizes" hint="compact 424 (window 452×144) · expanded 572 (600×282) · typing 572 (600×362). Radius 24, black 0.96, white 0.12 border, input bar 48.">
        <Matrix>
          <State label="compact · transcript" dark wide>
            <Box sx={{ overflowX: "auto", width: "100%" }}>
              <AssistantPanel size="compact" variant="transcript" scale={0.9} />
            </Box>
          </State>
          <State label="expanded · permission" dark wide>
            <Box sx={{ overflowX: "auto", width: "100%" }}>
              <AssistantPanel size="expanded" variant="permission" scale={0.85} />
            </Box>
          </State>
          <State label="typing · review" dark wide>
            <Box sx={{ overflowX: "auto", width: "100%" }}>
              <AssistantPanel size="typing" variant="review" scale={0.8} />
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="Interactive size">
        <Stack direction="row" spacing={1}>
          {(["compact", "expanded", "typing"] as PanelSize[]).map((s) => (
            <Button key={s} variant={size === s ? "blue" : "flat"} onClick={() => setSize(s)}>
              {s}
            </Button>
          ))}
        </Stack>
        <Box sx={{ mt: 2, overflowX: "auto" }}>
          <AssistantPanel size={size} variant="transcript" scale={0.9} />
        </Box>
      </DemoSection>
    </>
  );
};

export const AudioPlayerPillDemo = () => (
  <DemoSection title="AudioPlayerPill (recreated + simulated clock)" hint="Radius 999 pill, level1, divider border, maxWidth 350. Bars 2–4px / gap 2 / count 24–120, veil wipes with 140ms linear.">
    <TryIt>press play — progress wipes the waveform like production.</TryIt>
    <Matrix>
      <State label="default" wide>
        <AudioPlayerPillPreview durationMs={42000} />
      </State>
      <State label="playing">
        <AudioPlayerPillPreview durationMs={125000} autoplay />
      </State>
      <State label="disabled">
        <AudioPlayerPillPreview durationMs={8000} disabled />
      </State>
      <State label="no duration (0:00)">
        <AudioPlayerPillPreview durationMs={null} />
      </State>
      <State label="with actions">
        <AudioPlayerPillPreview durationMs={30000} actions={<EditIcon fontSize="small" color="secondary" />} />
      </State>
    </Matrix>
  </DemoSection>
);

export const ToolPermissionDemo = () => (
  <>
    <DemoSection title="ToolPermissionPrompt — default variant" hint="Chat card: maxWidth 75%, radius 8, primary.main border, paper fill. Pending shows Deny/Allow/Always-allow chips; resolved shows a status chip.">
      <Matrix>
        <State label="pending" wide>
          <ToolPermissionPromptPreview permission={PERMISSION_FIXTURES[0]} />
        </State>
        <State label="allowed">
          <ToolPermissionPromptPreview permission={PERMISSION_FIXTURES[1]} />
        </State>
        <State label="denied">
          <ToolPermissionPromptPreview permission={PERMISSION_FIXTURES[2]} />
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="Overlay variant" hint="White-on-dark: title 13/600 @ .92, body 12 @ .5, fill white .06, border white .2, radius 8. Buttons fire on mouse-down.">
      <Matrix>
        <State label="pending" dark wide>
          <ToolPermissionPromptPreview permission={PERMISSION_FIXTURES[0]} variant="overlay" />
        </State>
        <State label="resolved (no buttons)" dark>
          <ToolPermissionPromptPreview permission={PERMISSION_FIXTURES[1]} variant="overlay" />
        </State>
      </Matrix>
    </DemoSection>
  </>
);

export const ToneSelectDemo = () => (
  <>
    <DemoSection title="ToneSelect (recreated slice)" hint="MUI Select: 'New style' row (Add icon), tone rows with global-Public tooltip or per-row Edit (icon-button stops propagation). Empty value renders 'Default'.">
      <Matrix>
        <State label="default" wide>
          <Box sx={{ width: "100%", maxWidth: 320 }}>
            <ToneSelectPreview label="Style" />
          </Box>
        </State>
        <State label="with selection">
          <Box sx={{ width: "100%", maxWidth: 320 }}>
            <ToneSelectPreview value="tone-formal" />
          </Box>
        </State>
        <State label="disabled">
          <Box sx={{ width: "100%", maxWidth: 320 }}>
            <ToneSelectPreview disabled value="tone-concise" />
          </Box>
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="TranscriptionToneMenu pattern (real MenuPopover + ListTile)" hint="Row menus use MenuPopoverBuilder with the same Add/Edit rows as ToneSelect.">
      <Matrix>
        <State label="menu" wide>
          <MenuPopoverBuilder
            items={TONE_FIXTURES.map((t) => ({
              kind: "listItem" as const,
              title: t.name,
              trailing: <Typography variant="caption" color="text.secondary">Apply</Typography>,
              onClick: ({ close }: { close: () => void }) => close(),
            }))}
          >
            {({ ref, open }) => (
              <Button variant="flat" ref={ref} onClick={open}>Apply tone…</Button>
            )}
          </MenuPopoverBuilder>
        </State>
      </Matrix>
    </DemoSection>
  </>
);

export const MicCheckDemo = () => (
  <>
    <DemoSection title="MicrophoneSelector (recreated slice)" hint="Small fullWidth select: Automatic + Recommended chip, divider, device rows with Default/Caution chips and unavailable/caution captions. Refresh button + 18px spinner; error Alert.">
      <Matrix>
        <State label="default" wide>
          <Box sx={{ width: "100%", maxWidth: 480 }}>
            <MicrophoneSelectorPreview />
          </Box>
        </State>
        <State label="error">
          <Box sx={{ width: "100%", maxWidth: 480 }}>
            <MicrophoneSelectorPreview error="Microphone permission denied by the OS." />
          </Box>
        </State>
        <State label="loading">
          <Box sx={{ width: "100%", maxWidth: 480 }}>
            <MicrophoneSelectorPreview loading />
          </Box>
        </State>
        <State label="disabled">
          <Box sx={{ width: "100%", maxWidth: 480 }}>
            <MicrophoneSelectorPreview disabled />
          </Box>
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="MicrophoneTester (selector + real AudioWaveform)" hint="Same pairing as production: device select above a live level waveform.">
      <Matrix>
        <State label="default" wide>
          <Box sx={{ width: "100%", maxWidth: 480 }}>
            <MicrophoneTesterPreview />
          </Box>
        </State>
      </Matrix>
    </DemoSection>
  </>
);

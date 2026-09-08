/** Data display demos — all real components. */
import {
  ChatBubbleOutlined,
  CheckCircle,
  DeleteOutlined,
  HomeOutlined,
  MicNoneOutlined,
  SettingsOutlined,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { AppStepper } from "@desktop/components/common/AppStepper";
import { AppTable } from "@desktop/components/common/AppTable";
import { AudioWaveform } from "@desktop/components/common/AudioWaveform";
import { CopyableCommand } from "@desktop/components/common/CopyableCommand";
import { EditTypography } from "@desktop/components/common/EditTypography";
import { ListTile } from "@desktop/components/common/ListTile";
import { Logo } from "@desktop/components/common/Logo";
import { LogoWithText } from "@desktop/components/common/LogoWithText";
import { OverflowTypography } from "@desktop/components/common/OverflowTypography";
import { TypographyWithMore } from "@desktop/components/common/TypographyWithMore";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const CardPaperDemo = () => (
  <DemoSection title="Card · Paper" hint="Card: level1, radius 16, hairline 0.05, premiumSurface.rest; hover lifts −1px. Paper flat: same rest treatment, no hover lift.">
    <TryIt>hover the card — it lifts; the flat paper stays put.</TryIt>
    <Matrix>
      <State label="card (hoverable)">
        <Card sx={{ width: "100%", maxWidth: 300 }}>
          <CardContent>
            <Typography variant="titleSmall">Quarterly report</Typography>
            <Typography variant="bodySmall" color="text.secondary">Updated 2 hours ago</Typography>
          </CardContent>
        </Card>
      </State>
      <State label="paper flat">
        <Paper variant="flat" sx={{ p: 2, width: "100%", maxWidth: 300 }}>
          <Typography variant="bodyMedium">Flat panel content</Typography>
        </Paper>
      </State>
      <State label="paper outlined">
        <Paper variant="outlined" sx={{ p: 2, width: "100%", maxWidth: 300, borderRadius: 3 }}>
          <Typography variant="bodyMedium">Outlined panel</Typography>
        </Paper>
      </State>
    </Matrix>
  </DemoSection>
);

export const ListTileDemo = () => {
  const [selected, setSelected] = useState("a");
  return (
    <DemoSection title="ListTile" hint="Rows: radius 14, min-height 44, leading/trailing with hover swap, selected = ink fill (light) / level2 (dark). Press scale 0.975 over 90ms; no transition under reduced motion.">
      <TryIt>hover rows to swap trailing icons; click to select.</TryIt>
      <Matrix>
        <State label="default + selected" wide>
          <Stack sx={{ width: "100%", maxWidth: 420 }}>
            <ListTile
              leading={<MicNoneOutlined />}
              title="Morning dictation"
              subtitle="2 min · English"
              trailing="09:41"
              trailingHover={<DeleteOutlined />}
              selected={selected === "a"}
              onClick={() => setSelected("a")}
            />
            <ListTile
              leading={<ChatBubbleOutlined />}
              title="Standup notes with a very long title that truncates via OverflowTypography"
              subtitle="5 min · English"
              trailing="Yesterday"
              selected={selected === "b"}
              onClick={() => setSelected("b")}
            />
            <ListTile
              leading={<CheckCircle />}
              title="Done item"
              subtitle="Completed"
              selected={selected === "c"}
              onClick={() => setSelected("c")}
            />
          </Stack>
        </State>
        <State label="disabled">
          <Stack sx={{ width: "100%", maxWidth: 320 }}>
            <ListTile leading={<MicNoneOutlined />} title="Unavailable row" subtitle="Offline" disabled />
          </Stack>
        </State>
      </Matrix>
    </DemoSection>
  );
};

type DemoRow = { name: string; duration: number; lang: string };
const ROWS: DemoRow[] = [
  { name: "Morning pages", duration: 132, lang: "English" },
  { name: "Standup", duration: 305, lang: "English" },
  { name: "Idées déjeuner", duration: 88, lang: "French" },
  { name: "Abendnotizen", duration: 214, lang: "German" },
];

export const TableDemo = () => (
  <DemoSection title="AppTable" hint="Virtualized (react-virtuoso) in Paper. Weight/fixed columns; sortable headers toggle asc/desc.">
    <TryIt>click the Duration header to sort.</TryIt>
    <Matrix>
      <State label="default" wide>
        <Box sx={{ height: 260, width: "100%" }}>
          <AppTable<DemoRow>
            rows={ROWS}
            columns={[
              { header: "Name", cell: (r) => r.name, getSortKey: (r) => r.name, weight: 2 },
              { header: "Duration (s)", cell: (r) => r.duration, getSortKey: (r) => r.duration },
              { header: "Language", cell: (r) => r.lang, width: 140 },
            ]}
          />
        </Box>
      </State>
      <State label="empty">
        <Box sx={{ height: 160, width: "100%" }}>
          <AppTable<DemoRow>
            sx={{ height: "100%" }}
            rows={[]}
            columns={[{ header: "Name", cell: (r) => r.name }]}
          />
        </Box>
      </State>
    </Matrix>
  </DemoSection>
);

export const AccordionDemo = () => (
  <DemoSection title="Accordion" hint="level1, shape radius, premiumSurface.rest, no divider line. Summary 15/600, details 14 secondary.">
    <Matrix>
      <State label="default" wide>
        <Box sx={{ width: "100%", maxWidth: 480 }}>
          <Accordion defaultExpanded>
            <AccordionSummary>Transcription settings</AccordionSummary>
            <AccordionDetails>Provider, language, and post-processing options live here.</AccordionDetails>
          </Accordion>
          <Accordion>
            <AccordionSummary>Audio settings</AccordionSummary>
            <AccordionDetails>Microphone selection and input levels.</AccordionDetails>
          </Accordion>
          <Accordion disabled>
            <AccordionSummary>Disabled group</AccordionSummary>
            <AccordionDetails>Unavailable.</AccordionDetails>
          </Accordion>
        </Box>
      </State>
    </Matrix>
  </DemoSection>
);

export const StepperDemo = () => {
  const [index, setIndex] = useState(1);
  return (
    <DemoSection title="AppStepper" hint="Vertical stepper; active step becomes a 64px primary pill (label 18/600); clickable steps scale 1.05 on hover; completed show Check.">
      <Matrix>
        <State label="default" wide>
          <AppStepper
            index={index}
            readyIndex={2}
            onStepClick={setIndex}
            steps={[
              { label: "Sign in", icon: <HomeOutlined /> },
              { label: "Microphone", icon: <MicNoneOutlined /> },
              { label: "Finish", icon: <SettingsOutlined /> },
            ]}
          />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const TypographyHelpersDemo = () => {
  const [name, setName] = useState("Meeting notes");
  return (
    <>
      <DemoSection title="OverflowTypography" hint="Ellipsizes; tooltip appears only when actually overflowing.">
        <Matrix>
          <State label="overflowing (hover for tooltip)">
            <Box sx={{ width: 180 }}>
              <OverflowTypography>This title is far too long for its container</OverflowTypography>
            </Box>
          </State>
          <State label="fits (no tooltip)">
            <Box sx={{ width: 180 }}>
              <OverflowTypography>Short title</OverflowTypography>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="EditTypography" hint="Click-to-edit text with commit/cancel, optional validation + parsing.">
        <TryIt>click the name to edit, Enter to commit, Esc to cancel.</TryIt>
        <Matrix>
          <State label="default">
            <EditTypography value={name} onChange={(v) => setName(String(v))} />
          </State>
          <State label="number mode">
            <EditTypography value={42} type="number" onChange={() => {}} />
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="TypographyWithMore" hint="Line-clamped prose with More/Less toggle (localized labels).">
        <Matrix>
          <State label="clamped + expanded" wide>
            <Box sx={{ maxWidth: 420 }}>
              <TypographyWithMore maxLines={2}>
                Dictation captures your voice and turns it into clean text anywhere you can type. Styles reshape tone per app, and the pill keeps state visible without stealing focus from your work.
              </TypographyWithMore>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="CopyableCommand" hint="Monospace block + copy button; check (success, 16px) shows for 2000ms after copy.">
        <Matrix>
          <State label="default" wide>
            <Box sx={{ width: "100%", maxWidth: 480 }}>
              <CopyableCommand command="pnpm --filter desktop run dev:vite" />
            </Box>
          </State>
        </Matrix>
      </DemoSection>
    </>
  );
};

export const WaveformDemo = () => {
  const [levels, setLevels] = useState<number[]>([]);
  const [active, setActive] = useState(true);
  const [processing, setProcessing] = useState(false);
  const feed = () => {
    const id = setInterval(() => {
      setLevels(Array.from({ length: 32 }, () => Math.random()));
    }, 100);
    setTimeout(() => {
      clearInterval(id);
      setLevels([]);
    }, 4000);
  };
  return (
    <DemoSection title="AudioWaveform" hint="Live SVG waves: 3 configs, smoothing 0.18, decay 0.985/frame, stroke 1.6. Same physics the native pill ports.">
      <TryIt>feed levels and watch the waves breathe; toggle processing for the idle shimmer.</TryIt>
      <Matrix>
        <State label="live" wide>
          <AudioWaveform levels={levels} active={active} processing={processing} width={320} height={56} />
        </State>
        <State label="controls">
          <Button variant="flat" onClick={feed}>Feed levels</Button>
          <Button variant="text" onClick={() => setActive((a) => !a)}>{active ? "Deactivate" : "Activate"}</Button>
          <Button variant="text" onClick={() => setProcessing((p) => !p)}>{processing ? "Stop processing" : "Processing"}</Button>
        </State>
        <State label="idle (no levels)">
          <AudioWaveform levels={[]} active={false} width={200} height={40} />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const LogoDemo = () => (
  <DemoSection title="Logo · LogoWithText" hint="PNG mark (32/64/192) + TAN-PARADISO wordmark — one of the two sanctioned display-face uses.">
    <Matrix>
      <State label="mark">
        <Logo />
      </State>
      <State label="with wordmark">
        <LogoWithText />
      </State>
    </Matrix>
  </DemoSection>
);

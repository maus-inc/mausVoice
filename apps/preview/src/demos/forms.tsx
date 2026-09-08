/** Forms demos — real components except the store-bound hotkey surfaces. */
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
} from "@mui/material";
import { useState } from "react";
import { ElasticSlider } from "@desktop/components/common/ElasticSlider";
import { SegmentedControl } from "@desktop/components/common/SegmentedControl";
import { DictationInstructionPreview, HotKeyPreview, HotkeyBadgePreview } from "../recreated/hotkey";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const SwitchDemo = () => {
  const [on, setOn] = useState(true);
  return (
    <DemoSection title="Switch (square)" hint="shadcn switch-2 look on MUI: thumb radius 3, track radius 5, blue when checked.">
      <Matrix>
        <State label="on / off">
          <Switch checked={on} onChange={(_, v) => setOn(v)} slotProps={{ input: { "aria-label": "Demo switch" } }} />
          <Switch checked={false} onChange={() => {}} slotProps={{ input: { "aria-label": "Off switch" } }} />
        </State>
        <State label="disabled">
          <Switch checked disabled slotProps={{ input: { "aria-label": "Disabled on" } }} />
          <Switch disabled slotProps={{ input: { "aria-label": "Disabled off" } }} />
        </State>
        <State label="with label">
          <FormControlLabel control={<Switch defaultChecked />} label="Enable feature" />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const SliderDemo = () => {
  const [v, setV] = useState(40);
  return (
    <>
      <DemoSection title="ElasticSlider" hint="Local value during drag, onCommit on release — the thumb tracks the pointer 1:1. Rail/track 4px → 6px on hover; white 16px thumb with blue ring blooms on hover/drag; whileTap spring 1.015 (static under reduced motion).">
        <Matrix>
          <State label="default" wide>
            <Box sx={{ width: "100%", maxWidth: 420 }}>
              <ElasticSlider value={v} onCommit={setV} ariaLabel="Volume" />
            </Box>
          </State>
          <State label="with live display">
            <Box sx={{ width: "100%", maxWidth: 300 }}>
              <ElasticSlider value={v} onCommit={setV} onChangeDisplay={setV} ariaLabel="Live" />
            </Box>
          </State>
          <State label="disabled">
            <Box sx={{ width: "100%", maxWidth: 300 }}>
              <ElasticSlider value={30} onCommit={() => {}} disabled ariaLabel="Disabled" />
            </Box>
          </State>
          <State label="custom range + format">
            <Box sx={{ width: "100%", maxWidth: 300 }}>
              <ElasticSlider value={v} onCommit={setV} min={0} max={200} step={5} valueLabelFormat={(n) => `${n}%`} ariaLabel="Percent" />
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="Committed value">
        <Box>onCommit: {v}</Box>
      </DemoSection>
    </>
  );
};

export const SegmentedDemo = () => {
  const [mode, setMode] = useState<"off" | "api" | "local">("api");
  return (
    <DemoSection title="SegmentedControl" hint="Shared-layout indicator (per-instance layoutId) slides with springSnappy; static pill under reduced motion. Arrow-key navigation via MUI Tabs.">
      <TryIt>click between modes — the indicator glides, it never cuts.</TryIt>
      <Matrix>
        <State label="default" wide>
          <SegmentedControl
            value={mode}
            onChange={setMode}
            ariaLabel="Mode"
            options={[
              { value: "off", label: "Off" },
              { value: "api", label: "API" },
              { value: "local", label: "Local" },
            ]}
          />
        </State>
        <State label="with disabled option">
          <SegmentedControl
            value="a"
            onChange={() => {}}
            ariaLabel="Disabled option"
            options={[
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta", disabled: true },
              { value: "c", label: "Gamma" },
            ]}
          />
        </State>
        <State label="center aligned">
          <SegmentedControl
            value="x"
            onChange={() => {}}
            align="center"
            ariaLabel="Centered"
            options={[
              { value: "x", label: "X" },
              { value: "y", label: "Y" },
            ]}
          />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const TextFieldDemo = () => (
  <>
    <DemoSection title="TextField (MUI defaults on the ladder)" hint="theme.ts carries no TextField overrides — inputs render MUI v9 defaults in Satoshi on level1.">
      <Matrix>
        <State label="default / filled states">
          <TextField label="Name" placeholder="Ada Lovelace" size="small" />
          <TextField label="Email" defaultValue="ada@maus.inc" size="small" />
        </State>
        <State label="disabled">
          <TextField label="Disabled" disabled size="small" defaultValue="Locked" />
        </State>
        <State label="error">
          <TextField label="API key" error helperText="Key is invalid" size="small" defaultValue="sk-bad" />
        </State>
        <State label="loading (action pattern)">
          <TextField label="Search models" size="small" disabled defaultValue="Fetching…" />
        </State>
        <State label="select">
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel id="demo-select">Voice</InputLabel>
            <Select labelId="demo-select" label="Voice" defaultValue="alloy">
              <MenuItem value="alloy">Alloy</MenuItem>
              <MenuItem value="echo">Echo</MenuItem>
            </Select>
          </FormControl>
        </State>
        <State label="checkbox / radio">
          <FormControlLabel control={<Checkbox defaultChecked />} label="Check" />
          <RadioGroup defaultValue="a" row>
            <FormControlLabel value="a" control={<Radio />} label="A" />
            <FormControlLabel value="b" control={<Radio />} label="B" />
          </RadioGroup>
        </State>
      </Matrix>
    </DemoSection>
  </>
);

export const HotkeyBadgeDemo = () => (
  <>
    <DemoSection title="HotkeyBadge (recreated)" hint="Inline-flex kbd: 1px divider border, radius 4, px 8 / py 2, weight 600, level1 fill. Clickable variant hovers action.hover.">
      <Matrix>
        <State label="default">
          <HotkeyBadgePreview keys={["ControlLeft", "ShiftLeft", "KeyD"]} />
        </State>
        <State label="clickable">
          <HotkeyBadgePreview keys={["MetaLeft", "KeyK"]} onClick={() => {}} />
        </State>
        <State label="arrows + function">
          <HotkeyBadgePreview keys={["AltLeft", "LeftArrow"]} />
          <HotkeyBadgePreview keys={["Function", "KeyF"]} />
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="DictationInstruction (recreated)" hint="body2 secondary prompt + badge. Renders nothing when no combo is bound (empty state).">
      <Matrix>
        <State label="default" wide>
          <DictationInstructionPreview />
        </State>
        <State label="empty (no combo)">
          <DictationInstructionPreview combo={null} />
          <Box sx={{ color: "text.secondary", fontSize: 13 }}>(renders null)</Box>
        </State>
      </Matrix>
    </DemoSection>
  </>
);

export const HotkeyRecorderDemo = () => {
  const [value, setValue] = useState<string[]>(["ControlLeft", "KeyD"]);
  return (
    <DemoSection title="HotKey recorder (recreated + local key shim)" hint="200×40, radius 8, level1 → level2 on focus, 2px pulsing blue border (2s ease-in-out infinite). Focus and press keys — Escape cancels.">
      <TryIt>click the field, then press a chord like Ctrl+Shift+M.</TryIt>
      <Matrix>
        <State label="empty">
          <HotKeyPreview value={[]} />
        </State>
        <State label="with value">
          <HotKeyPreview value={value} onChange={setValue} />
        </State>
        <State label="recording (focus it)">
          <HotKeyPreview />
        </State>
      </Matrix>
      <Box sx={{ mt: 2 }}>
        <Button variant="text" onClick={() => setValue([])}>Clear</Button>
      </Box>
    </DemoSection>
  );
};

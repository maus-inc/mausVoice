/** Foundations demos — rendered from the REAL token modules. */
import { Box, Button, Stack, Typography, useColorScheme } from "@mui/material";
import { motion } from "framer-motion";
import { useState } from "react";
import { AnimateIn, AnimateSwitch } from "@desktop/components/common/AnimateIn";
import { SegmentedControl } from "@desktop/components/common/SegmentedControl";
import { duration, easeInOutCubic, easeOutCubic, easeOutQuint, springSnappy, springSoft } from "@desktop/styles/motion";
import { accent, chalkSolid, ink, inkSolid, onDark, surfaces, text } from "@desktop/styles/palette";
import { accentSurface, hairline, premiumSurface, titleBarShadow } from "@desktop/styles/shadows";
import { DemoSection, Matrix, Row, State, Swatch, TokenRow, TryIt } from "../components/demo-ui";

export const ColorDemo = () => {
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  return (
    <>
      <DemoSection title="Surface ladder — light (cream paper)">
        <Row>
          {(Object.entries(surfaces.light) as [string, string][]).map(([tier, hex]) => (
            <Swatch key={tier} color={hex} label={`level${tier.slice(-1)} · ${tier}`} value={hex} />
          ))}
        </Row>
      </DemoSection>
      <DemoSection title="Surface ladder — dark (onyx)">
        <Row>
          {(Object.entries(surfaces.dark) as [string, string][]).map(([tier, hex]) => (
            <Swatch key={tier} color={hex} label={`level${tier.slice(-1)} · ${tier}`} value={hex} border />
          ))}
        </Row>
      </DemoSection>
      <DemoSection title="Ink · text ramps · accent">
        <Row>
          <Swatch color={inkSolid.base} label="inkSolid.base (light primary)" value={inkSolid.base} />
          <Swatch color={inkSolid.raised} label="inkSolid.raised (hover)" value={inkSolid.raised} />
          <Swatch color={inkSolid.pressed} label="inkSolid.pressed" value={inkSolid.pressed} />
          <Swatch color={chalkSolid.base} label="chalkSolid.base (dark primary)" value="#FFFFFF" border />
          <Swatch color={`#${accent.light.main.slice(1, 7)}`} label="accent light" value={accent.light.main} />
          <Swatch color={`#${accent.dark.main.slice(1, 7)}`} label="accent dark" value={accent.dark.main} />
        </Row>
        <Box sx={{ mt: 2, maxWidth: 560 }}>
          <TokenRow token="text.light.primary" value={text.light.primary} />
          <TokenRow token="text.light.secondary" value={text.light.secondary} />
          <TokenRow token="text.light.disabled" value={text.light.disabled} />
          <TokenRow token="text.dark.primary" value={text.dark.primary} />
          <TokenRow token="text.dark.secondary" value={text.dark.secondary} />
          <TokenRow token="text.dark.disabled" value={text.dark.disabled} />
          <TokenRow token="ink(0.08) divider (light)" value={ink(0.08)} />
          <TokenRow token="onDark sample" value={onDark(0.64)} />
          <TokenRow token="hairline.light()" value={hairline.light()} />
          <TokenRow token="hairline.dark()" value={hairline.dark()} />
        </Box>
      </DemoSection>
      <DemoSection title="Live scheme" hint="Toggle light/dark in the site header — every swatch and demo follows the real MUI color scheme.">
        <Typography variant="bodyMedium">Current scheme: {dark ? "dark" : "light"}</Typography>
      </DemoSection>
    </>
  );
};

const TYPE_ROWS: { variant: string; sample: string }[] = [
  { variant: "displayLarge", sample: "Display large 57" },
  { variant: "displayMedium", sample: "Display medium 45" },
  { variant: "displaySmall", sample: "Display small 36" },
  { variant: "headlineLarge", sample: "Headline large 32" },
  { variant: "headlineMedium", sample: "Headline medium 28" },
  { variant: "headlineSmall", sample: "Headline small 24" },
  { variant: "titleLarge", sample: "Title large 22" },
  { variant: "titleMedium", sample: "Title medium 17" },
  { variant: "titleSmall", sample: "Title small 15" },
  { variant: "bodyLarge", sample: "Body large 17 — the quick brown fox" },
  { variant: "bodyMedium", sample: "Body medium 15 — the quick brown fox" },
  { variant: "bodySmall", sample: "Body small 13 — the quick brown fox" },
  { variant: "labelLarge", sample: "Label large 15" },
  { variant: "labelMedium", sample: "Label medium 13" },
  { variant: "labelSmall", sample: "Label small 12" },
];

export const TypographyDemo = () => (
  <>
    <DemoSection title="Type scale (Satoshi)" hint="One family for product UI. tabular-nums is global — digits below share width: 0123456789.">
      <Stack spacing={1}>
        {TYPE_ROWS.map((r) => (
          <Typography key={r.variant} variant={r.variant as "bodyMedium"}>
            {r.sample}
          </Typography>
        ))}
      </Stack>
    </DemoSection>
    <DemoSection title="Display face (restricted)" hint="TAN-PARADISO — logo wordmark and welcome/name only. Never body/settings.">
      <Typography sx={{ fontFamily: "var(--font-display, 'TAN-PARADISO')", fontSize: 32 }}>
        Welcome back
      </Typography>
    </DemoSection>
  </>
);

export const ElevationDemo = () => {
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const set = dark ? premiumSurface.dark : premiumSurface.light;
  return (
    <>
      <DemoSection title="premiumSurface states" hint="2px inner top emboss + multi-stop drop. Elevation reads from luminance + hairlines first; shadows only on layered/floating faces.">
        <Matrix>
          {(Object.entries(set) as [string, string][]).map(([name, shadow]) => (
            <State key={name} label={name}>
              <Box sx={{ width: 120, height: 72, borderRadius: 3.5, backgroundColor: "level1", boxShadow: shadow }} />
            </State>
          ))}
          <State label="accentSurface (blue CTA)">
            <Box sx={{ width: 120, height: 72, borderRadius: 3.5, backgroundColor: "blue", boxShadow: dark ? accentSurface.dark : accentSurface.light }} />
          </State>
          <State label="titleBarShadow">
            <Box sx={{ width: 160, height: 40, backgroundColor: "level1", boxShadow: dark ? titleBarShadow.dark : titleBarShadow.light }} />
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="Hairlines over shadows">
        <Box sx={{ maxWidth: 560 }}>
          <TokenRow token="hairline.light(0.04)" value={hairline.light(0.04)} />
          <TokenRow token="hairline.light(0.08)" value={hairline.light(0.08)} />
          <TokenRow token="hairline.dark(0.04)" value={hairline.dark(0.04)} />
          <TokenRow token="hairline.dark(0.08)" value={hairline.dark(0.08)} />
          <TokenRow token="MUI shadows" value="Array(25).fill('none') — elevation is luminance, not shadow" />
        </Box>
      </DemoSection>
    </>
  );
};

export const MotionDemo = () => {
  const [n, setN] = useState(0);
  return (
    <>
      <DemoSection title="Duration tokens (seconds in motion.ts, ms in theme.transitions)">
        <Box sx={{ maxWidth: 560 }}>
          <TokenRow token="duration.instant / shortest" value={`${duration.instant}s · 100ms`} />
          <TokenRow token="duration.fast / shorter" value={`${duration.fast}s · 150ms`} />
          <TokenRow token="duration.base / short" value={`${duration.base}s · 180ms`} />
          <TokenRow token="duration.enter / enteringScreen" value={`${duration.enter}s · 250ms`} />
          <TokenRow token="duration.exit / leavingScreen" value={`${duration.exit}s · 180ms`} />
          <TokenRow token="standard / complex" value="220ms · 280ms (theme only)" />
          <TokenRow token="easeOut quint" value={`cubic-bezier(${easeOutQuint.join(", ")})`} />
          <TokenRow token="sharp (easeOutCubic)" value={`cubic-bezier(${easeOutCubic.join(", ")})`} />
          <TokenRow token="easeInOutCubic" value={`cubic-bezier(${easeInOutCubic.join(", ")})`} />
          <TokenRow token="springSnappy" value={`spring · stiffness ${springSnappy.stiffness} · damping ${springSnappy.damping} · mass ${springSnappy.mass}`} />
          <TokenRow token="springSoft" value={`spring · stiffness ${springSoft.stiffness} · damping ${springSoft.damping} · mass ${springSoft.mass}`} />
        </Box>
      </DemoSection>
      <DemoSection title="Spring comparison" hint="Same 120px move. Snappy drives chrome + shared-layout indicators; soft is reserved for larger panels.">
        <TryIt>press replay — both springs start on your click with no delay.</TryIt>
        <Row>
          <Button variant="flat" onClick={() => setN((v) => v + 1)}>Replay</Button>
        </Row>
        <Stack spacing={2} sx={{ mt: 2 }}>
          {(["snappy", "soft"] as const).map((kind) => (
            <Box key={`${kind}-${n}`} sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Typography variant="labelSmall" sx={{ width: 64 }}>{kind}</Typography>
              <Box sx={{ position: "relative", height: 28, flex: 1, backgroundColor: "level2", borderRadius: 2 }}>
                <Box
                  component={motion.div}
                  initial={{ x: 0 }}
                  animate={{ x: 120 }}
                  transition={kind === "snappy" ? springSnappy : springSoft}
                  sx={{ position: "absolute", top: 4, left: 4, width: 20, height: 20, borderRadius: 1, backgroundColor: "blue" }}
                />
              </Box>
            </Box>
          ))}
        </Stack>
      </DemoSection>
    </>
  );
};

export const AnimateDemo = () => {
  const [visible, setVisible] = useState(true);
  const [tab, setTab] = useState<"off" | "api" | "local">("off");
  return (
    <>
      <DemoSection title="AnimateIn" hint="Appear/disappear: opacity + y 6 + scale 0.99, springSnappy. Reduced motion falls back to a bare opacity fade. Outgoing content is inert + aria-hidden.">
        <Row>
          <Button variant="flat" onClick={() => setVisible((v) => !v)}>{visible ? "Hide" : "Show"}</Button>
        </Row>
        <Box sx={{ mt: 2, minHeight: 72 }}>
          <AnimateIn visible={visible}>
            <Box sx={{ p: 2, borderRadius: 3, backgroundColor: "level2", display: "inline-block" }}>
              <Typography variant="bodyMedium">Springs in and out</Typography>
            </Box>
          </AnimateIn>
        </Box>
      </DemoSection>
      <DemoSection title="AnimateSwitch" hint="Mutually-exclusive sections crossfade with mode='wait' (container height stays honest). y 8, springSnappy.">
        <SegmentedControl
          value={tab}
          options={[
            { value: "off", label: "Off" },
            { value: "api", label: "API" },
            { value: "local", label: "Local" },
          ]}
          onChange={setTab}
          ariaLabel="AnimateSwitch demo"
        />
        <Box sx={{ mt: 2 }}>
          <AnimateSwitch activeKey={tab}>
            <Box sx={{ p: 2, borderRadius: 3, backgroundColor: "level2" }}>
              <Typography variant="bodyMedium">Mode: {tab}</Typography>
              <Typography variant="bodySmall" color="text.secondary">
                Content keyed by mode so state cannot bleed across swaps.
              </Typography>
            </Box>
          </AnimateSwitch>
        </Box>
      </DemoSection>
    </>
  );
};

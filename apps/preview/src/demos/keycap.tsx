/**
 * Keycap3d demo.
 *
 * The cap is the real component. The camera and the shape ratios come from the
 * spec editor instead of being frozen, so the shape can be tuned against the
 * reference render without a rebuild. The spec defaults are the numbers the app
 * ships, so a fresh load shows the production cap.
 */
import { Box, Paper, Stack, Typography } from "@mui/material";
import { Keycap3d } from "@desktop/components/common/Keycap3d";
import {
  ANGLE_VIEW,
  KEYCAP_RATIOS,
  type KeycapRatios,
} from "@desktop/components/common/keycap3d.geometry";
import { keycapDashboardSize, keycapGrain } from "@desktop/styles/keycap";
import type { ReactNode } from "react";
import { DemoSection, State } from "../components/demo-ui";
import { useSpecValue } from "../lib/spec-store";

const ENTRY = "keycap-3d";

const useCapShape = () => {
  const tilt = useSpecValue(ENTRY, "tilt", ANGLE_VIEW.tilt);
  const spin = useSpecValue(ENTRY, "spin", ANGLE_VIEW.spin);
  const roll = useSpecValue(ENTRY, "roll", ANGLE_VIEW.roll);
  const perspective = useSpecValue(
    ENTRY,
    "perspective",
    ANGLE_VIEW.perspectiveFactor,
  );
  const height = useSpecValue(ENTRY, "height", KEYCAP_RATIOS.height * 100);
  const face = useSpecValue(ENTRY, "face", KEYCAP_RATIOS.face * 100);
  const radius = useSpecValue(ENTRY, "radius", KEYCAP_RATIOS.radius * 100);
  const faceTilt = useSpecValue(ENTRY, "faceTilt", KEYCAP_RATIOS.faceTilt);
  const dish = useSpecValue(ENTRY, "dish", KEYCAP_RATIOS.dish * 100);
  const grain = useSpecValue(ENTRY, "grain", keycapGrain);
  const ratios: Partial<KeycapRatios> = {
    height: height / 100,
    face: face / 100,
    radius: radius / 100,
    faceTilt,
    dish: dish / 100,
  };
  return { tilt, spin, roll, perspective, grain, ratios };
};

/** The two panel treatments from the reference render, on the real surfaces. */
const Panel = ({
  title,
  caption,
  scheme,
  children,
}: {
  title: string;
  caption: string;
  scheme: "light" | "dark";
  children: ReactNode;
}) => (
  <Paper
    variant="flat"
    data-mui-color-scheme={scheme}
    sx={{
      bgcolor: "level0",
      color: "text.primary",
      borderRadius: 2,
      p: 3,
      minHeight: 420,
      display: "flex",
      flexDirection: "column",
      gap: 2,
    }}
  >
    <Typography variant="titleSmall">{title}</Typography>
    <Box
      sx={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </Box>
    <Typography variant="bodySmall" color="text.secondary">
      {caption}
    </Typography>
  </Paper>
);

/** The dashboard row from the app, with the caps in place. */
const DictationRow = ({ size = keycapDashboardSize }: { size?: number }) => {
  const { ratios, grain } = useCapShape();
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Press your hotkey to dictate anywhere
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
        {["Alt", "X"].map((legend) => (
          <Keycap3d
            key={legend}
            label={legend}
            size={size}
            ratios={ratios}
            grain={grain}
          />
        ))}
      </Stack>
    </Stack>
  );
};

export const Keycap3dDemo = () => {
  const { tilt, spin, roll, perspective, grain, ratios } = useCapShape();
  const angle = { tilt, spin, roll, perspectiveFactor: perspective, ratios };

  return (
    <Box>
      <DemoSection
        title="Prototype cameras"
        hint="Both views use the same shape. The camera controls adjust the angle view. The dashboard camera is not yet validated against a front-view reference."
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
            gap: 2,
          }}
        >
          <Panel
            title="Front view"
            caption="Provisional near-overhead camera for the dashboard badge."
            scheme="dark"
          >
            <Keycap3d
              label="→"
              size={190}
              view="front"
              grain={grain}
              ratios={ratios}
            />
          </Panel>
          <Panel
            title="Angle view"
            caption="The 3/4 camera, for the onboarding steps."
            scheme="light"
          >
            <Keycap3d
              label="→"
              size={190}
              view="angle"
              grain={grain}
              {...angle}
            />
          </Panel>
        </Box>
      </DemoSection>

      <DemoSection
        title="Onboarding scale"
        hint="Angle view across the sizes an onboarding hero could take. The skirt, the corner radius and the legend all scale with the base edge."
      >
        <Stack
          direction="row"
          spacing={4}
          sx={{ alignItems: "flex-end", flexWrap: "wrap" }}
        >
          {[64, 96, 140, 190, 250].map((size) => (
            <Keycap3d
              key={size}
              label="Alt"
              size={size}
              view="angle"
              grain={grain}
              {...angle}
            />
          ))}
        </Stack>
      </DemoSection>

      <DemoSection
        title="Dashboard row"
        hint="The dictation row from the home page. Grain contrast fades as the caps get smaller."
      >
        <Stack spacing={3} sx={{ alignItems: "flex-start" }}>
          <DictationRow />
          <DictationRow size={keycapDashboardSize - 6} />
        </Stack>
      </DemoSection>

      <DemoSection
        title="Side legend"
        hint="A key with a side stacks the side above the glyph, so AltLeft reads as Left over Alt and never as one long word."
      >
        <Stack
          direction="row"
          spacing={3}
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          {[
            { label: "⇧", sublabel: "Left" },
            { label: "⇧", sublabel: "Right" },
            { label: "Ctrl", sublabel: "Left" },
            { label: "Alt", sublabel: "Left" },
          ].map(({ label, sublabel }) => (
            <Keycap3d
              key={`${label}-${sublabel}`}
              label={label}
              sublabel={sublabel}
              size={84}
              view="front"
              grain={grain}
            />
          ))}
        </Stack>
        <Box sx={{ mt: 2 }}>
          <State label="Left Shift at dashboard size">
            <Keycap3d
              label="⇧"
              sublabel="Left"
              size={keycapDashboardSize}
              view="front"
              grain={grain}
              ratios={ratios}
            />
          </State>
        </Box>
      </DemoSection>

      <DemoSection
        title="Front view scale"
        hint="Labels are sized from the face, so a two letter key and a one letter key stay in proportion."
      >
        <Stack
          direction="row"
          spacing={3}
          sx={{ alignItems: "center", flexWrap: "wrap" }}
        >
          {[
            { size: 24, label: "X" },
            { size: 28, label: "Alt" },
            { size: 34, label: "Alt" },
            { size: 44, label: "⌘" },
            { size: 60, label: "Shift" },
            { size: 84, label: "↩" },
          ].map(({ size, label }) => (
            <Keycap3d
              key={size}
              label={label}
              size={size}
              view="front"
              grain={grain}
            />
          ))}
        </Stack>
      </DemoSection>

      <DemoSection
        title="Proportion sweep"
        hint="Roll-over and height against the reference."
      >
        <Stack
          direction="row"
          spacing={2}
          sx={{ flexWrap: "wrap", alignItems: "flex-start" }}
        >
          {[0.05, 0.07, 0.09, 0.12].map((radius) =>
            [0.52, 0.6, 0.68].map((height) => (
              <Stack
                key={`${radius}-${height}`}
                spacing={0.5}
                sx={{ alignItems: "center" }}
              >
                <Keycap3d
                  label="X"
                  size={120}
                  view="angle"
                  grain={0}
                  ratios={{ radius, height }}
                />
                <Typography variant="bodySmall" color="text.secondary">
                  r{Math.round(radius * 100)} h{Math.round(height * 100)}
                </Typography>
              </Stack>
            )),
          )}
        </Stack>
      </DemoSection>

      <DemoSection title="Camera sweep" hint="Elevation and spin.">
        <Stack
          direction="row"
          spacing={2}
          sx={{ flexWrap: "wrap", alignItems: "flex-start" }}
        >
          {[46, 52, 58].map((tilt) =>
            [-14, -22, -30].map((spin) => (
              <Stack
                key={`${tilt}-${spin}`}
                spacing={0.5}
                sx={{ alignItems: "center" }}
              >
                <Keycap3d
                  label="X"
                  size={110}
                  view="angle"
                  grain={0}
                  tilt={tilt}
                  spin={spin}
                />
                <Typography variant="bodySmall" color="text.secondary">
                  t{tilt} s{spin}
                </Typography>
              </Stack>
            )),
          )}
        </Stack>
      </DemoSection>

      <DemoSection
        title="Grain"
        hint="The clean procedural grain follows the cap surface. It fades at small raster sizes to limit aliasing."
      >
        <State label="Rest, textured">
          <Keycap3d
            label="Alt"
            size={140}
            view="angle"
            grain={grain}
            {...angle}
          />
        </State>
        <State label="grain 0">
          <Keycap3d label="Alt" size={140} view="angle" grain={0} {...angle} />
        </State>
        <State label="pressed">
          <Keycap3d
            label="Alt"
            size={140}
            view="angle"
            grain={grain}
            pressed
            {...angle}
          />
        </State>
      </DemoSection>
    </Box>
  );
};

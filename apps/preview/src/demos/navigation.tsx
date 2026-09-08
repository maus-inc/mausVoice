/** Navigation demos. */
import { Settings } from "@mui/icons-material";
import { Box, Button, Typography } from "@mui/material";
import { House, Mic, Settings as SettingsLucide } from "lucide";
import { useState } from "react";
import { Breadcrumb } from "@desktop/components/common/Breadcrumb";
import { MorphNavIcon } from "@desktop/components/common/MorphNavIcon";
import { DashboardMenuPreview } from "../recreated/dashboard-menu";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const BreadcrumbDemo = () => (
  <DemoSection title="Breadcrumb" hint="body2 trail; ancestors are secondary links (underline on hover), current page is primary/500. onClick wins over href navigation.">
    <Matrix>
      <State label="default" wide>
        <Breadcrumb
          items={[
            { label: "Settings" },
            { label: "Transcription" },
            { label: "Providers" },
          ]}
        />
      </State>
      <State label="custom separator">
        <Breadcrumb separator="›" items={[{ label: "Home" }, { label: "Library" }]} />
      </State>
    </Matrix>
  </DemoSection>
);

export const DashboardMenuDemo = () => (
  <DemoSection title="DashboardMenu (recreated shell, real rows)" hint="Rail: radius 16, 0.35rem margin, hairline 0.05, 180deg wash (level1→level0 light, level2→level0 dark). Active row: shared-layout indicator (layoutId sidebar-active, springSnappy), ink fill in light / level2 in dark, static under reduced motion.">
    <TryIt>click rows — the indicator morphs between them; it never cuts.</TryIt>
    <Matrix>
      <State label="default" wide>
        <DashboardMenuPreview />
      </State>
      <State label="with update tile">
        <DashboardMenuPreview showUpdate initial="/settings" />
      </State>
    </Matrix>
  </DemoSection>
);

export const MorphIconDemo = () => {
  const [icon, setIcon] = useState<"home" | "mic" | "settings">("home");
  const node = icon === "home" ? House : icon === "mic" ? Mic : SettingsLucide;
  return (
    <DemoSection title="MorphNavIcon" hint="morphicons spring morph on node change (spring='snappy'), 22px, strokeWidth 1.85, currentColor.">
      <TryIt>swap icons — paths tween instead of cutting.</TryIt>
      <Matrix>
        <State label="morphing">
          <MorphNavIcon icon={node} />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button variant={icon === "home" ? "blue" : "text"} onClick={() => setIcon("home")}>Home</Button>
            <Button variant={icon === "mic" ? "blue" : "text"} onClick={() => setIcon("mic")}>Mic</Button>
            <Button variant={icon === "settings" ? "blue" : "text"} onClick={() => setIcon("settings")}>Settings</Button>
          </Box>
        </State>
        <State label="sizes">
          <MorphNavIcon icon={House} size={16} />
          <MorphNavIcon icon={House} size={22} />
          <MorphNavIcon icon={House} size={32} />
        </State>
        <State label="MUI icon (contrast)">
          <Typography variant="bodySmall" color="text.secondary">TitleBar pairs morphing lucide glyphs with MUI icons elsewhere:</Typography>
          <Settings />
        </State>
      </Matrix>
    </DemoSection>
  );
};

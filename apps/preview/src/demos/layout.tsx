/** Layout + window-chrome demos — all real components. */
import { History, MicNoneOutlined } from "@mui/icons-material";
import { Box, Button, Stack, Switch, Typography } from "@mui/material";
import { useState } from "react";
import { FadingScrollArea } from "@desktop/components/common/FadingScrollArea";
import { ListTile } from "@desktop/components/common/ListTile";
import { PageLayout } from "@desktop/components/common/PageLayout";
import { ScrollListPage } from "@desktop/components/common/ScrollListPage";
import { Section } from "@desktop/components/common/Section";
import { SettingSection } from "@desktop/components/common/SettingSection";
import { SplitLayout } from "@desktop/components/common/SplitLayout";
import { TitleBar } from "@desktop/components/root/TitleBar";
import { ThemeModeToggle } from "@desktop/components/root/ThemeModeToggle";
import { WindowResizeHandles } from "@desktop/components/root/WindowResizeHandles";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const LayoutDemo = () => {
  const [enabled, setEnabled] = useState(true);
  const [items, setItems] = useState(() => Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`));
  return (
    <>
      <DemoSection title="SettingSection" hint="Row: space-between; title body1/600, description body2 secondary (or rich descriptionSlot).">
        <Matrix>
          <State label="default" wide>
            <Box sx={{ width: "100%", maxWidth: 560 }}>
              <SettingSection
                title="Automatic gain"
                description="Normalize input volume across microphones."
                action={<Switch defaultChecked slotProps={{ input: { "aria-label": "Automatic gain" } }} />}
              />
            </Box>
          </State>
          <State label="descriptionSlot">
            <Box sx={{ width: "100%" }}>
              <SettingSection
                title="Devices"
                descriptionSlot={
                  <Typography variant="bodySmall" color="warning.main">
                    1 device unavailable
                  </Typography>
                }
                action={<Button variant="text">Manage</Button>}
              />
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="Section" hint="h6 bold header + optional checkbox toggle + body2 description; blocked renders at 30% opacity behind a not-allowed tooltip veil.">
        <Matrix>
          <State label="enabled toggle" wide>
            <Box sx={{ width: "100%" }}>
              <Section
                title="Post-processing"
                description="Clean up transcripts with a local model."
                enabled={enabled}
                onToggleEnable={() => setEnabled((v) => !v)}
              >
                <Typography variant="bodySmall">Child controls go here.</Typography>
              </Section>
            </Box>
          </State>
          <State label="blocked">
            <Box sx={{ width: "100%" }}>
              <Section title="Cloud sync" description="Pro feature." blocked blockedReason="Requires Pro">
                <Typography variant="bodySmall">Hidden.</Typography>
              </Section>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="FadingScrollArea" hint="Scroll viewport with top/bottom fade masks (fadeHeight).">
        <Matrix>
          <State label="default">
            <FadingScrollArea sx={{ height: 160, width: 240 }}>
              {Array.from({ length: 20 }, (_, i) => (
                <Typography key={i} variant="bodySmall" sx={{ py: 0.5 }}>
                  Line {i + 1} — scroll to see the fades
                </Typography>
              ))}
            </FadingScrollArea>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="SplitLayout" hint="Weighted columns; zero-weight panes unmount (stay mounted once shown).">
        <Matrix>
          <State label="weights [1, 2]" wide>
            <Box sx={{ width: "100%" }}>
              <SplitLayout weights={[1, 2]}>
                <Box sx={{ p: 2, backgroundColor: "level2", borderRadius: 2 }}>Pane A</Box>
                <Box sx={{ p: 2, backgroundColor: "level2", borderRadius: 2 }}>Pane B (2×)</Box>
              </SplitLayout>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="ScrollListPage" hint="List template: header (title/action/subtitle, maxWidth sm) + items + emptyState + infinite onLoadMore. Used by Apps, Dictionary, Styling, Transcriptions.">
        <Matrix>
          <State label="default" wide>
            <Box sx={{ height: 320, width: "100%", overflow: "hidden", borderRadius: 2 }}>
              <ScrollListPage
                title="Transcriptions"
                subtitle={`${items.length} items`}
                action={<Button variant="blue">New</Button>}
                items={items}
                renderItem={(item) => (
                  <ListTile leading={<MicNoneOutlined />} title={item} subtitle="English · 2 min" />
                )}
                hasMore={items.length < 30}
                onLoadMore={() => setItems((prev) => [...prev, ...Array.from({ length: 6 }, (_, i) => `Item ${prev.length + i + 1}`)])}
                emptyState={<Typography>No items</Typography>}
              />
            </Box>
          </State>
          <State label="empty">
            <Box sx={{ height: 200, width: "100%", overflow: "hidden" }}>
              <ScrollListPage
                title="Empty list"
                items={[]}
                renderItem={(item: string) => <Typography>{item}</Typography>}
                emptyState={<Typography color="text.secondary">Nothing here yet.</Typography>}
              />
            </Box>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="PageLayout" hint="App shell: TitleBar + header slot + scroll content + footer. Renders the real TitleBar (drag region no-ops outside Tauri).">
        <Matrix>
          <State label="default" wide>
            <Box sx={{ height: 300, width: "100%", borderRadius: 2, overflow: "hidden" }}>
              <PageLayout header={<Typography variant="titleSmall" sx={{ px: 2 }}>Header slot</Typography>}>
                <Typography variant="bodySmall" sx={{ p: 2 }}>Content scrolls here.</Typography>
              </PageLayout>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
    </>
  );
};

export const TitlebarDemo = () => (
  <>
    <DemoSection title="TitleBar (real, Tauri-guarded)" hint="Frameless chrome: 40px, level1 @ 0.88/0.92 + blur(18px) saturate(1.2) + titleBarShadow. Drag region + double-click maximize; window controls no-op in a plain browser (isTauriRuntime gate). Glyphs morph through MorphNavIcon.">
      <TryIt>open the theme menu (left) — it drives the real MUI color scheme.</TryIt>
      <Matrix>
        <State label="default" wide>
          <Box sx={{ width: "100%", borderRadius: 2, overflow: "hidden", border: "1px solid", borderColor: "divider" }}>
            <TitleBar />
            <Box sx={{ p: 2 }}>
              <Typography variant="bodySmall" color="text.secondary">Window content below the bar.</Typography>
            </Box>
          </Box>
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="ThemeModeToggle" hint="28×28, radius 12, morphing sun/moon/monitor, 150ms transitions; menu lists Light/Dark/System with check.">
      <Matrix>
        <State label="default">
          <ThemeModeToggle />
          <Typography variant="bodySmall" color="text.secondary">click to open the scheme menu</Typography>
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="WindowResizeHandles" hint="Eight invisible edge/corner grips handing resize to the window manager. Rendered here invisibly, as in production — hover the demo edges in the desktop app.">
      <Matrix>
        <State label="mounted (invisible)" wide>
          <Box sx={{ position: "relative", height: 80 }}>
            <WindowResizeHandles />
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <History fontSize="small" />
              <Typography variant="bodySmall" color="text.secondary">
                Handles are transparent by design; they only exist to catch edge drags under decorations:false.
              </Typography>
            </Stack>
          </Box>
        </State>
      </Matrix>
    </DemoSection>
  </>
);

/** Dialogs & feedback demos — real components except the snackbar visual. */
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import InfoIcon from "@mui/icons-material/Info";
import ShareIcon from "@mui/icons-material/Share";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { AppCircularProgress } from "@desktop/components/common/AppCircularProgress";
import { CenterLoading } from "@desktop/components/common/CenterLoading";
import { CenterMessage } from "@desktop/components/common/CenterMessage";
import { ConditionalTooltip } from "@desktop/components/common/ConditionalTooltip";
import { ConfirmDialog } from "@desktop/components/common/ConfirmDialog";
import { ContextMenu, useContextMenu } from "@desktop/components/common/ContextMenu";
import { DialogTitleWithClose } from "@desktop/components/common/DialogTitleWithClose";
import { MenuPopoverBuilder } from "@desktop/components/common/MenuPopover";
import { ToolParamsTooltip } from "@desktop/components/common/ToolParamsTooltip";
import { BouncyTooltip } from "@desktop/components/onboarding/BouncyTooltip";
import { SnackbarPreview } from "../recreated/snackbar";
import { DemoSection, Matrix, State, TryIt } from "../components/demo-ui";

export const DialogDemo = () => {
  const [open, setOpen] = useState(false);
  return (
    <DemoSection title="Dialog + DialogTitleWithClose" hint="Paper: level1, radius 18, hairline, premiumSurface.hover. Title row has a small close IconButton (aria 'Close'). Esc/backdrop close via MUI.">
      <Matrix>
        <State label="default" wide>
          <Button variant="flat" onClick={() => setOpen(true)}>Open dialog</Button>
          <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
            <DialogTitleWithClose onClose={() => setOpen(false)}>Settings</DialogTitleWithClose>
            <DialogContent dividers>
              <DialogContentText>Dialog body copy. Focus is trapped; Esc closes.</DialogContentText>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
              <Button variant="text" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="contained" onClick={() => setOpen(false)}>Save</Button>
            </DialogActions>
          </Dialog>
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const ConfirmDialogDemo = () => {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState("—");
  return (
    <DemoSection title="ConfirmDialog" hint="maxWidth xs fullWidth, dividers, Cancel (text) + Confirm (contained). Labels + button props overridable.">
      <Matrix>
        <State label="default" wide>
          <Button variant="flat" startIcon={<DeleteIcon />} onClick={() => setOpen(true)}>
            Delete style…
          </Button>
          <Typography variant="bodySmall" color="text.secondary">Result: {result}</Typography>
          <ConfirmDialog
            isOpen={open}
            title="Delete style?"
            content="This removes the style from every app that uses it. This cannot be undone."
            onCancel={() => { setOpen(false); setResult("cancelled"); }}
            onConfirm={() => { setOpen(false); setResult("confirmed"); }}
          />
        </State>
        <State label="custom labels">
          <ConfirmDialog
            isOpen={false}
            title="Discard changes?"
            content="Unsaved edits will be lost."
            onCancel={() => {}}
            onConfirm={() => {}}
            cancelLabel="Keep editing"
            confirmLabel="Discard"
          />
          <Typography variant="bodySmall" color="text.secondary">(closed instance — labels shown when open)</Typography>
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const PopoverMenuDemo = () => (
  <DemoSection title="MenuPopoverBuilder" hint="Anchor popover of ListTile rows, dividers, submenus (hover, fixed-positioned), and generic builders.">
    <TryIt>open the menu, hover into the submenu, activate a row.</TryIt>
    <Matrix>
      <State label="default" wide>
        <MenuPopoverBuilder
          items={[
            { kind: "listItem", title: "Edit style", leading: <EditIcon fontSize="small" />, onClick: ({ close }) => close() },
            { kind: "listItem", title: "Share", leading: <ShareIcon fontSize="small" />, onClick: ({ close }) => close() },
            { kind: "divider" },
            {
              kind: "subMenu",
              title: "More actions",
              leading: <InfoIcon fontSize="small" />,
              children: [
                { kind: "listItem", title: "Duplicate", onClick: ({ close }) => close() },
                { kind: "listItem", title: "Archive", onClick: ({ close }) => close() },
              ],
            },
            { kind: "genericItem", builder: ({ close }) => <Button variant="text" onClick={close}>Custom builder row</Button> },
          ]}
        >
          {({ ref, open }) => (
            <Button variant="flat" ref={ref} onClick={open}>Open menu</Button>
          )}
        </MenuPopoverBuilder>
      </State>
    </Matrix>
  </DemoSection>
);

export const ContextMenuDemo = () => {
  const ctx = useContextMenu();
  const show = (e: React.MouseEvent) =>
    ctx.handleContextMenu(e.nativeEvent, [
      { label: "Copy transcript", onClick: () => {} },
      { label: "Re-transcribe", accelerator: "⌘R", onClick: () => {} },
      { kind: "divider" },
      { label: "Delete", danger: true, onClick: () => {} },
      { label: "Disabled action", disabled: true, onClick: () => {} },
    ]);
  return (
    <DemoSection title="ContextMenu (right-click)" hint="Viewport-clamped, portal to body, Esc consumes (capture) so wrapping dialogs don't close, focus restored on keyboard dismissal only.">
      <TryIt>right-click the surface. Empty item lists fall through to the native menu.</TryIt>
      <Matrix>
        <State label="default (right-click me)" wide>
          <Box
            onContextMenu={show}
            sx={{ p: 3, borderRadius: 2, backgroundColor: "level2", cursor: "context-menu", userSelect: "none" }}
          >
            Right-click surface
          </Box>
          {ctx.renderMenu()}
        </State>
        <State label="inline render">
          <ContextMenu
            items={[
              { label: "Inline item", onClick: () => {} },
              { label: "With accelerator", accelerator: "⌘C", onClick: () => {} },
            ]}
          />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const TooltipDemo = () => {
  const [bouncy, setBouncy] = useState(true);
  return (
    <>
      <DemoSection title="Tooltip + ConditionalTooltip + ToolParamsTooltip" hint="Themed tooltip: 13px/550, radius 10, 8/12 padding, premiumSurface.rest.">
        <Matrix>
          <State label="default">
            <Tooltip title="Save changes"><Button variant="flat">Hover me</Button></Tooltip>
          </State>
          <State label="placements">
            <Tooltip title="Top" placement="top"><Button variant="text">Top</Button></Tooltip>
            <Tooltip title="Right" placement="right"><Button variant="text">Right</Button></Tooltip>
          </State>
          <State label="conditional (enabled / disabled)">
            <ConditionalTooltip title="Shown" enabled><Button variant="text">Shown</Button></ConditionalTooltip>
            <ConditionalTooltip title="Hidden" enabled={false}><Button variant="text">Hidden</Button></ConditionalTooltip>
          </State>
          <State label="tool params (JSON)">
            <ToolParamsTooltip params={{ path: "src/index.ts", reason: "hidden from display" }} />
            <Typography variant="bodySmall" color="text.secondary">hover the ⓘ</Typography>
          </State>
          <State label="tool params · empty (renders null)">
            <ToolParamsTooltip params={{}} />
            <Typography variant="bodySmall" color="text.secondary">(renders null)</Typography>
          </State>
        </Matrix>
      </DemoSection>
      <DemoSection title="BouncyTooltip" hint="Absolute attention bubble: 1s bounce (dropped under reduced motion) + 0.2s fade-in; exit fades down 0.2s. Arrow 8px, primary.main fill.">
        <Matrix>
          <State label="visible toggle" wide>
            <Box sx={{ position: "relative", height: 120, width: "100%", backgroundColor: "level2", borderRadius: 2 }}>
              <BouncyTooltip visible={bouncy}>
                <Typography variant="bodySmall">Press your hotkey to dictate</Typography>
              </BouncyTooltip>
              <Box sx={{ position: "absolute", top: 8, left: 8 }}>
                <Button variant="text" onClick={() => setBouncy((v) => !v)}>
                  {bouncy ? "Hide" : "Show"}
                </Button>
              </Box>
            </Box>
          </State>
        </Matrix>
      </DemoSection>
    </>
  );
};

export const SnackbarDemo = () => {
  const [mode, setMode] = useState<"info" | "error" | "success">("info");
  const [n, setN] = useState(0);
  return (
    <DemoSection title="Snackbar (recreated emitter visual)" hint="bottom-center, #fff message, close button, clickaway ignored, 3000ms default. Fills: primary / error / success.">
      <TryIt>fire each mode — the snackbar anchors bottom-center like production.</TryIt>
      <Matrix>
        <State label="modes" wide>
          <Stack direction="row" spacing={1}>
            {(["info", "error", "success"] as const).map((m) => (
              <Button key={m} variant={mode === m ? "blue" : "flat"} onClick={() => { setMode(m); setN((v) => v + 1); }}>
                {m}
              </Button>
            ))}
          </Stack>
          <SnackbarPreview
            key={`${mode}-${n}`}
            message={mode === "error" ? "Unable to play audio snippet." : mode === "success" ? "Style saved." : "Compositor reload may be needed."}
            mode={mode}
          />
        </State>
      </Matrix>
    </DemoSection>
  );
};

export const FeedbackDemo = () => (
  <>
    <DemoSection title="AppCircularProgress" hint="Thin wrapper: determinate when value is set, indeterminate otherwise.">
      <Matrix>
        <State label="indeterminate / determinate">
          <AppCircularProgress />
          <AppCircularProgress value={65} />
        </State>
        <State label="sizes">
          <AppCircularProgress size={20} />
          <AppCircularProgress size={48} />
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="CenterLoading" hint="Full-height centered spinner, pb 8.">
      <Matrix>
        <State label="default" wide>
          <Box sx={{ height: 140, width: "100%" }}><CenterLoading /></Box>
        </State>
      </Matrix>
    </DemoSection>
    <DemoSection title="CenterMessage (empty state)" hint="flex-1 centered, Container xs, Stack spacing 2, py 8.">
      <Matrix>
        <State label="title + subtitle + action" wide>
          <CenterMessage
            title="No transcriptions yet"
            subtitle="Press your hotkey anywhere to dictate your first note."
            action={<Button variant="blue">Learn how</Button>}
          />
        </State>
        <State label="title only">
          <CenterMessage title="All caught up" />
        </State>
      </Matrix>
    </DemoSection>
  </>
);

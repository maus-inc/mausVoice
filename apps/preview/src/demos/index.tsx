/** Demo key → component map. Keys match RegistryEntry.demo. */
import type { ComponentType } from "react";
import { AccordionDemo, CardPaperDemo, ListTileDemo, LogoDemo, StepperDemo, TableDemo, TypographyHelpersDemo, WaveformDemo } from "./data";
import { ConfirmDialogDemo, ContextMenuDemo, DialogDemo, FeedbackDemo, PopoverMenuDemo, SnackbarDemo, TooltipDemo } from "./dialogs";
import { AnimateDemo, ColorDemo, ElevationDemo, MotionDemo, TypographyDemo } from "./foundations";
import { HotkeyBadgeDemo, HotkeyRecorderDemo, SegmentedDemo, SliderDemo, SwitchDemo, TextFieldDemo } from "./forms";
import { ButtonDemo, FabDemo, IconButtonDemo } from "./buttons";
import { LayoutDemo, TitlebarDemo } from "./layout";
import { BreadcrumbDemo, DashboardMenuDemo, MorphIconDemo } from "./navigation";
import { AssistantPanelDemo, AudioPlayerPillDemo, MicCheckDemo, NativePillDemo, ToneSelectDemo, ToolPermissionDemo } from "./pill";

export const DEMOS: Record<string, ComponentType> = {
  color: ColorDemo,
  typography: TypographyDemo,
  elevation: ElevationDemo,
  motion: MotionDemo,
  animate: AnimateDemo,
  button: ButtonDemo,
  "icon-button": IconButtonDemo,
  fab: FabDemo,
  switch: SwitchDemo,
  slider: SliderDemo,
  segmented: SegmentedDemo,
  "text-field": TextFieldDemo,
  "hotkey-badge": HotkeyBadgeDemo,
  "hotkey-recorder": HotkeyRecorderDemo,
  dialog: DialogDemo,
  "confirm-dialog": ConfirmDialogDemo,
  "popover-menu": PopoverMenuDemo,
  "context-menu": ContextMenuDemo,
  tooltip: TooltipDemo,
  snackbar: SnackbarDemo,
  feedback: FeedbackDemo,
  "card-paper": CardPaperDemo,
  "list-tile": ListTileDemo,
  table: TableDemo,
  accordion: AccordionDemo,
  stepper: StepperDemo,
  breadcrumb: BreadcrumbDemo,
  "typography-helpers": TypographyHelpersDemo,
  waveform: WaveformDemo,
  logo: LogoDemo,
  "dashboard-menu": DashboardMenuDemo,
  "morph-icon": MorphIconDemo,
  layout: LayoutDemo,
  titlebar: TitlebarDemo,
  "native-pill": NativePillDemo,
  "assistant-panel": AssistantPanelDemo,
  "audio-player-pill": AudioPlayerPillDemo,
  "tool-permission": ToolPermissionDemo,
  "tone-select": ToneSelectDemo,
  "mic-check": MicCheckDemo,
};

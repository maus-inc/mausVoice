import type { DictationPillVisibility, Nullable } from "@maus-inc/types";
import type { IntlShape } from "react-intl";
import { getEffectivePillVisibility } from "./user.utils";

/**
 * Label identifier for the tray's pill-visibility item.
 *
 * The label names the action a click performs, not the current state.
 * This type serves as an internal contract/identifier; actual user-facing
 * text is resolved via i18n.
 */
export type TrayPillMenuLabel = "Hide Pill" | "Show Pill";

/**
 * Next visibility for a tray click.
 *
 * `hidden` is the only state that reveals the pill; both visible states
 * (`persistent` and `while_active`) collapse to `hidden`, so one item can drive
 * a three-valued preference. Invalid input normalizes to `persistent` first,
 * and therefore yields `hidden`.
 *
 * Note this is deliberately not a round trip: hiding from `while_active` and
 * showing again lands on `persistent`. A single control cannot preserve
 * `while_active`, and `persistent` is the state whose name matches what the
 * user just asked for ("show the pill").
 */
export const getNextPillVisibility = (
  current?: Nullable<string>,
): DictationPillVisibility =>
  getEffectivePillVisibility(current) === "hidden" ? "persistent" : "hidden";

/**
 * Tray label identifier for a visibility value.
 *
 * Derived from the persisted preference, never from whether the native pill
 * window happens to be on screen — in Assistant mode the pill is visible even
 * when the preference is `hidden`, and the menu must still offer "Show Pill".
 */
export const getPillMenuLabel = (
  current?: Nullable<string>,
): TrayPillMenuLabel =>
  getEffectivePillVisibility(current) === "hidden" ? "Show Pill" : "Hide Pill";

/**
 * Localized tray pill visibility label.
 *
 * Resolves the user-facing text for the pill visibility menu item based on the
 * effective visibility state, following the same pattern as tray language menu
 * localization.
 */
export const getLocalizedPillMenuLabel = (
  current: Nullable<string>,
  intl: IntlShape,
): string => {
  const effective = getEffectivePillVisibility(current);
  return effective === "hidden"
    ? intl.formatMessage({ defaultMessage: "Show Pill" })
    : intl.formatMessage({ defaultMessage: "Hide Pill" });
};

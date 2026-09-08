/**
 * HotkeyBadge + DictationInstruction + HotKey — recreated.
 *
 * Why recreated: HotkeyBadge imports getPrettyKeyName from
 * utils/keyboard.utils, which pulls the zustand store + tauri invoke +
 * platform utils; HotKey and DictationInstruction read the store directly
 * (keysHeld, hotkeyStrategy, combos). None of that runs in a plain browser.
 *
 * Fidelity: Box/Typography styles are copied verbatim from
 *  - components/common/HotkeyBadge.tsx
 *  - components/common/DictationInstruction.tsx
 *  - components/common/HotKey.tsx (incl. pulseBorder keyframes)
 * Key-name mapping copies getPrettyKeyName rules (keyboard.utils.ts:168-200):
 * KeyX→X, Meta→⌘/⊞, Control→⌃/Ctrl, Shift→⇧/Shift, Alt→⌥/Alt, arrows→glyphs.
 * Platform here is derived from navigator (preview-only shim; the app uses
 * getPlatform() from the window manager).
 */
import { Box, Typography, keyframes } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { Stack } from "@mui/system";
import { useEffect, useRef, useState } from "react";
import { useSpecValue } from "../lib/spec-store";

const isMac =
  typeof navigator !== "undefined" &&
  (/Mac/i.test(navigator.platform) ||
    (navigator as Navigator & { userAgentData?: { platform: string } })
      .userAgentData?.platform
      ?.toLowerCase()
      .includes("mac"));

/** Copy of getPrettyKeyName's mapping rules (side-label suffix omitted:
 *  appendSideLabel only disambiguates Left/Right variants). */
export const prettyKeyName = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower.startsWith("key")) return key.slice(3).toUpperCase();
  if (lower.startsWith("meta")) return isMac ? "⌘" : "⊞";
  if (lower.startsWith("control")) return isMac ? "⌃" : "Ctrl";
  if (lower.startsWith("shift")) return isMac ? "⇧" : "Shift";
  if (lower.startsWith("alt") || lower.startsWith("option")) return isMac ? "⌥" : "Alt";
  if (lower.startsWith("function")) return "Fn";
  if (key === "LeftArrow") return "←";
  if (key === "RightArrow") return "→";
  if (key === "UpArrow") return "↑";
  if (key === "DownArrow") return "↓";
  return key;
};

export const HotkeyBadgePreview = ({
  keys,
  onClick,
  sx,
}: {
  keys: string[];
  onClick?: () => void;
  sx?: SxProps<Theme>;
}) => {
  const radius = useSpecValue("hotkey-badge", "radius", 4);
  const label = keys.map(prettyKeyName).join(" + ");
  return (
    <Box
      onClick={onClick}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: `${radius}px`,
        px: 1,
        py: 0.25,
        fontWeight: 600,
        bgcolor: (theme) => theme.vars?.palette.level1,
        ...(onClick && {
          cursor: "pointer",
          "&:hover": { bgcolor: "action.hover" },
        }),
        ...sx,
      }}
    >
      {label}
    </Box>
  );
};

export const DictationInstructionPreview = ({
  combo = ["ControlLeft", "ShiftLeft", "KeyD"],
}: {
  combo?: string[] | null;
}) => {
  if (!combo) return null;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="body2" component="div" sx={{ color: "text.secondary" }}>
        Press your hotkey to dictate anywhere
      </Typography>
      <HotkeyBadgePreview keys={combo} onClick={() => {}} sx={{ flexShrink: 0 }} />
    </Stack>
  );
};

const pulseBorder = keyframes`
  0%, 100% {
    border-color: color-mix(in srgb, var(--app-palette-blue) 50%, transparent);
  }
  50% {
    border-color: var(--app-palette-blue);
  }
`;

/** HotKey with a local key-capture shim standing in for the store's keysHeld. */
export const HotKeyPreview = ({
  value: controlled,
  onChange,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
}) => {
  const width = useSpecValue("hotkey-recorder", "width", 200);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [inner, setInner] = useState<string[]>(controlled ?? []);
  const value = controlled ?? inner;

  useEffect(() => {
    if (controlled) setInner(controlled);
  }, [controlled]);

  useEffect(() => {
    if (!focused) return;
    const held = new Set<string>();
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        boxRef.current?.blur();
        return;
      }
      held.add(e.code);
      setHasInteracted(true);
      const next = [...held];
      setInner(next);
      onChange?.(next);
    };
    const up = () => {
      if (held.size > 0) {
        held.clear();
        boxRef.current?.blur();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [focused, onChange]);

  const empty = focused && !hasInteracted ? true : value.length === 0;
  const label =
    focused && !hasInteracted
      ? "Recording keys..."
      : value.length > 0
        ? value.map(prettyKeyName).join(" + ")
        : "Set hotkey";

  return (
    <Box
      ref={boxRef}
      tabIndex={0}
      role="button"
      aria-label={`Hotkey recorder. ${label}`}
      onClick={() => boxRef.current?.focus()}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setHasInteracted(false);
      }}
      sx={{
        width,
        height: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 1,
        cursor: "pointer",
        bgcolor: (t) => (focused ? t.vars?.palette.level2 : t.vars?.palette.level1),
        border: focused ? "2px solid" : "2px solid transparent",
        animation: focused ? `${pulseBorder} 2s ease-in-out infinite` : "none",
        outline: "none",
        "&:hover": {
          border: (t) => (focused ? "2px solid" : `2px solid ${t.vars?.palette.divider}`),
        },
      }}
    >
      <Typography variant="body2" color={empty ? "text.secondary" : "text.primary"}>
        {label}
      </Typography>
    </Box>
  );
};

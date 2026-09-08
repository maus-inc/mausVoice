/**
 * Assistant panel — geometry recreation from the native pill process.
 *
 * Exact constants (packages/rust_macos_pill/src/constants.rs + draw.rs):
 *  compact panel 424 wide (window 452×144) · expanded 572 (window 600×282) ·
 *  typing 600×362 · radius 24 · bg black 0.96 · border white 0.12 ·
 *  top margin 14, bottom margin 10 · header offsets 10/10, right 24 ·
 *  header buttons 28 · content side inset 24 · transcript top offset 56 ·
 *  input bar 48 · perm card 68 (buttons 80×26, gap 6, first +16) ·
 *  review eyebrow Satoshi 11 italic white .5, text 14 white .92 ·
 *  hint 11 white .45 · perm title 12 white .82, desc 11 white .5 ·
 *  buttons fill white .08, border white .15, label 11, radius 6 ·
 *  cards fill white .06, border white .12.
 */
import { Box } from "@mui/material";
import { useSpecValue } from "../lib/spec-store";

export type PanelSize = "compact" | "expanded" | "typing";

const WINDOW: Record<PanelSize, { w: number; h: number }> = {
  compact: { w: 452, h: 144 },
  expanded: { w: 600, h: 282 },
  typing: { w: 600, h: 362 },
};
const PANEL_W: Record<PanelSize, number> = { compact: 424, expanded: 572, typing: 572 };

const Satoshi = '"Satoshi", system-ui, sans-serif';

const HeaderButton = ({ glyph, x, y }: { glyph: string; x: number; y: number }) => (
  <Box
    sx={{
      position: "absolute",
      left: x,
      top: y,
      width: 28,
      height: 28,
      borderRadius: "50%",
      border: "1px solid rgba(255,255,255,0.15)",
      backgroundColor: "rgba(255,255,255,0.06)",
      color: "rgba(255,255,255,0.8)",
      fontSize: 13,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: Satoshi,
    }}
  >
    {glyph}
  </Box>
);

export const AssistantPanel = ({
  size,
  variant = "transcript",
  scale = 1,
}: {
  size: PanelSize;
  /** transcript: scrolling text · permission: tool-permission card · review: review-before-insert card */
  variant?: "transcript" | "permission" | "review";
  scale?: number;
}) => {
  const radius = useSpecValue("assistant-panel", "radius", 24);
  const bg = useSpecValue("assistant-panel", "bg", 0.96);
  const win = WINDOW[size];
  const panelW = PANEL_W[size];
  const panelH = win.h - 14 - 10;
  const panelX = (win.w - panelW) / 2;

  return (
    <Box
      role="img"
      aria-label={`Assistant panel — ${size} — ${variant}`}
      sx={{
        width: win.w * scale,
        height: win.h * scale,
        position: "relative",
        transformOrigin: "top left",
      }}
    >
      <Box sx={{ position: "absolute", inset: 0, transform: `scale(${scale})`, transformOrigin: "top left", width: win.w, height: win.h }}>
        {/* faint window outline so the transparent margin reads on any canvas */}
        <Box sx={{ position: "absolute", inset: 0, borderRadius: 2, border: "1px dashed rgba(128,128,128,0.35)" }} />
        <Box
          sx={{
            position: "absolute",
            left: panelX,
            top: 14,
            width: panelW,
            height: panelH,
            borderRadius: `${radius}px`,
            backgroundColor: `rgba(0,0,0,${bg})`,
            border: "1px solid rgba(255,255,255,0.12)",
            overflow: "hidden",
            fontFamily: Satoshi,
          }}
        >
          {/* header buttons: left 10, top 10; right inset 24 */}
          <HeaderButton glyph="⧉" x={10} y={10} />
          <HeaderButton glyph="⌄" x={10 + 28 + 4} y={10} />
          <HeaderButton glyph="✕" x={panelW - 24 - 28} y={10} />

          {/* content */}
          <Box sx={{ position: "absolute", left: 24, right: 24, top: 56, bottom: 48 + (variant === "review" ? 44 : 0), overflow: "hidden" }}>
            {variant === "transcript" && (
              <>
                <Box sx={{ fontSize: 14, lineHeight: "20px", color: "rgba(255,255,255,0.92)" }}>
                  Here is the cleaned-up transcript of what you just dictated, ready to insert.
                </Box>
                <Box sx={{ fontSize: 12, mt: 1, color: "rgba(255,255,255,0.5)" }}>
                  0:42 · English · whisper-large
                </Box>
              </>
            )}
            {variant === "permission" && (
              <Box
                sx={{
                  height: 68,
                  borderRadius: 2,
                  backgroundColor: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  p: 1.25,
                  position: "relative",
                }}
              >
                <Box sx={{ fontSize: 12, color: "rgba(255,255,255,0.82)", fontWeight: 600 }}>
                  read_file · package.json
                </Box>
                <Box sx={{ fontSize: 11, color: "rgba(255,255,255,0.5)", mt: 0.25 }}>
                  The assistant wants to read this file.
                </Box>
                <Box sx={{ position: "absolute", right: 10, bottom: 8, display: "flex", gap: "6px" }}>
                  {["Allow once", "Deny"].map((label, i) => (
                    <Box
                      key={label}
                      sx={{
                        width: i === 0 ? 96 : 80,
                        height: 26,
                        borderRadius: "6px",
                        backgroundColor: "rgba(255,255,255,0.08)",
                        border: "1px solid rgba(255,255,255,0.15)",
                        color: "rgba(255,255,255,0.9)",
                        fontSize: 11,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {label}
                    </Box>
                  ))}
                </Box>
              </Box>
            )}
            {variant === "review" && (
              <>
                <Box sx={{ fontSize: 11, fontStyle: "italic", color: "rgba(255,255,255,0.5)", height: 20 }}>
                  REVIEW TRANSCRIPT
                </Box>
                <Box sx={{ fontSize: 14, lineHeight: "20px", color: "rgba(255,255,255,0.92)" }}>
                  “Send the quarterly report to Priya by Friday.”
                </Box>
              </>
            )}
          </Box>

          {/* review actions row (44 high, fixed above input) */}
          {variant === "review" && (
            <Box sx={{ position: "absolute", left: 24, right: 24, bottom: 48, height: 44, display: "flex", alignItems: "center", gap: 1 }}>
              <Box sx={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
                Edit below, then press Enter to insert
              </Box>
              <Box sx={{ flex: 1 }} />
              {["Reject", "Accept"].map((label) => (
                <Box
                  key={label}
                  sx={{
                    width: 64,
                    height: 26,
                    borderRadius: "6px",
                    backgroundColor: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    color: "rgba(255,255,255,0.9)",
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {label}
                </Box>
              ))}
            </Box>
          )}

          {/* input bar (48) */}
          <Box
            sx={{
              position: "absolute",
              left: 24,
              right: 24,
              bottom: 0,
              height: 48,
              display: "flex",
              alignItems: "center",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              color: "rgba(255,255,255,0.45)",
              fontSize: 13,
              gap: 1,
            }}
          >
            <Box sx={{ width: 32, height: 32, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)", flexShrink: 0 }} />
            <Box>Type a follow-up…</Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

import { Box, type SxProps, type Theme } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  keycapGrain,
  keycapLabel,
  keycapLabelStack,
  keycapTravel,
} from "../../styles/keycap";
import {
  layoutKeycap,
  type KeycapRatios,
  type KeycapView,
} from "./keycap3d.geometry";
import { getCapRaster } from "./keycap3d.raster";
import { releaseCapRaster, requestCapRaster } from "./keycap3d.worker-client";
import { geistPixelTextWidth } from "./keycap3d.font-metrics";

export type Keycap3dProps = {
  /** Legend displayed over the cap face. */
  label?: React.ReactNode;
  /** Side label stacked above the legend, like "Left" over the shift glyph. */
  sublabel?: React.ReactNode;
  /** Base edge length in px. Everything else is a ratio of this. */
  size?: number;
  view?: KeycapView;
  /** Moves the cap down to indicate a press. */
  pressed?: boolean;
  /** Grain over the plastic, 0 to 1. Reduced at small raster sizes. */
  grain?: number;
  /** Camera overrides for the angle view. */
  tilt?: number;
  spin?: number;
  roll?: number;
  perspectiveFactor?: number;
  /** Geometry overrides, for tuning the shape without editing the ratios. */
  ratios?: Partial<KeycapRatios>;
  sx?: SxProps<Theme>;
};

const fontSizeForWidth = (faceSize: number, width: number): number =>
  faceSize * Math.min(0.46, 0.92 / Math.max(width, 1));

export const keycapLabelFontSize = (faceSize: number, label: string): number =>
  fontSizeForWidth(faceSize, geistPixelTextWidth(label, 0.02));

/** Cap on the raster's longest side, so a 250px cap stays cheap to paint. */
const MAX_RASTER = 420;
/**
 * A keycap drawn as a rendered rounded box, so the 3/4 view on the onboarding
 * steps and the near-front view in the dashboard come from the same model and
 * cannot drift apart. See `keycap3d.geometry.ts` for the shape, the camera
 * and the shading, and `styles/keycap.ts` for the material.
 *
 * The cap is presentational. Callers own the semantics, which is the contract
 * `HotkeyBadge` already relies on.
 */
export const Keycap3d = ({
  label,
  sublabel,
  size = 96,
  view = "front",
  pressed = false,
  grain = keycapGrain,
  tilt,
  spin,
  roll,
  perspectiveFactor,
  ratios,
  sx,
}: Keycap3dProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderState, setRenderState] = useState<
    "pending" | "ready" | "fallback"
  >("pending");
  const height = ratios?.height;
  const face = ratios?.face;
  const radius = ratios?.radius;
  const faceTilt = ratios?.faceTilt;
  const dish = ratios?.dish;
  const layout = useMemo(
    () =>
      layoutKeycap({
        size,
        view,
        tilt,
        spin,
        roll,
        perspectiveFactor,
        ratios: { height, face, radius, faceTilt, dish },
      }),
    [
      size,
      view,
      tilt,
      spin,
      roll,
      perspectiveFactor,
      height,
      face,
      radius,
      faceTilt,
      dish,
    ],
  );
  const labelWidth =
    typeof label === "string"
      ? geistPixelTextWidth(label, 0.02)
      : label == null
        ? 0
        : geistPixelTextWidth("X", 0.02);
  const sublabelWidth =
    typeof sublabel === "string"
      ? geistPixelTextWidth(sublabel, 0.04) * keycapLabelStack.scale
      : sublabel == null
        ? 0
        : geistPixelTextWidth("X", 0.04) * keycapLabelStack.scale;
  const legendSize = fontSizeForWidth(
    layout.faceSize,
    Math.max(labelWidth, sublabelWidth),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let media: MediaQueryList | undefined;
    let active = true;
    let contextLost = false;
    let generation = 0;
    let pendingRequest: Promise<ImageData> | null = null;
    const paint = () => {
      media?.removeEventListener("change", paint);
      const current = ++generation;
      if (pendingRequest) releaseCapRaster(pendingRequest);
      pendingRequest = null;
      const pixelRatio = window.devicePixelRatio || 1;
      media = window.matchMedia?.(`(resolution: ${pixelRatio}dppx)`);
      media?.addEventListener("change", paint);
      if (contextLost) return;
      const scale = Math.min(
        Math.max(pixelRatio, 1),
        MAX_RASTER / Math.max(layout.width, layout.height),
      );
      canvas.width = Math.ceil(layout.width * scale);
      canvas.height = Math.ceil(layout.height * scale);
      setRenderState("pending");
      let context: CanvasRenderingContext2D | null;
      try {
        context = canvas.getContext("2d");
      } catch {
        context = null;
      }
      if (!context) {
        setRenderState("fallback");
        return;
      }
      const options = { layout, grain, scale };
      const put = (image: ImageData) => {
        if (!active || current !== generation) return;
        try {
          context.putImageData(image, 0, 0);
          setRenderState("ready");
        } catch {
          setRenderState("fallback");
        }
      };
      const paintLocally = () => {
        if (!active || current !== generation) return;
        try {
          put(getCapRaster(options));
        } catch {
          setRenderState("fallback");
        }
      };
      pendingRequest = requestCapRaster(options);
      if (pendingRequest) void pendingRequest.then(put, paintLocally);
      else paintLocally();
    };
    const onContextLost = () => {
      contextLost = true;
      generation += 1;
      if (pendingRequest) releaseCapRaster(pendingRequest);
      pendingRequest = null;
      setRenderState("fallback");
    };
    const onContextRestored = () => {
      contextLost = false;
      paint();
    };
    canvas.addEventListener("contextlost", onContextLost);
    canvas.addEventListener("contextrestored", onContextRestored);
    paint();
    return () => {
      active = false;
      if (pendingRequest) releaseCapRaster(pendingRequest);
      media?.removeEventListener("change", paint);
      canvas.removeEventListener("contextlost", onContextLost);
      canvas.removeEventListener("contextrestored", onContextRestored);
    };
  }, [layout, grain]);

  // Keep the shortcut readable while a worker is queued or stalled, not only
  // after it fails. The canvas and projected legend appear together when ready.
  const showFallback = renderState !== "ready";
  const travel = pressed ? size * keycapTravel : 0;
  const [a, b, c, d] = layout.faceMatrix;
  const [wx, wy] = layout.facePerspective;
  const faceProjection = [a, b, 0, wx, c, d, 0, wy, 0, 0, 1, 0, 0, 0, 0, 1];

  return (
    <Box
      component="span"
      data-keycap-view={view}
      data-keycap-fallback={renderState === "fallback" ? "true" : undefined}
      sx={[
        {
          position: "relative",
          display: "inline-block",
          width: layout.width,
          height: layout.height,
          flexShrink: 0,
          userSelect: "none",
          ...(showFallback
            ? {
                bgcolor: "level1",
                border: "1px solid",
                borderColor: "level3",
                borderRadius: 1,
              }
            : {}),
          transform: travel === 0 ? undefined : `translateY(${travel}px)`,
          "@media (prefers-reduced-motion: reduce)": {
            transform: "none",
          },
          "@media (forced-colors: active)": {
            backgroundColor: "Canvas",
            border: "1px solid CanvasText",
            borderRadius: 1,
            "& [data-keycap-part='cap']": { visibility: "hidden" },
            "& [data-keycap-part='label']": {
              transform: "translate(-50%, -50%)",
              color: "CanvasText",
              textShadow: "none",
            },
          },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Box
        component="canvas"
        ref={canvasRef}
        data-keycap-part="cap"
        aria-hidden
        sx={{
          display: "block",
          width: layout.width,
          height: layout.height,
          visibility: showFallback ? "hidden" : "visible",
        }}
      />
      {(label !== undefined || sublabel !== undefined) && (
        <Box
          component="span"
          data-keycap-part="label"
          sx={{
            position: "absolute",
            left: "50%",
            top: "50%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            transform: showFallback
              ? "translate(-50%, -50%)"
              : `translate(${layout.faceCentreX}px, ${layout.faceCentreY}px) matrix3d(${faceProjection.join(", ")}) translate(-50%, -50%)`,
            transformOrigin: "0 0",
            fontFamily: keycapLabel.fontFamily,
            visibility: "visible",
            lineHeight: 1,
            whiteSpace: "nowrap",
            color: showFallback ? "text.primary" : keycapLabel.color,
            textShadow: showFallback
              ? "none"
              : `0 1px 1px ${keycapLabel.shadowColor}`,
            fontSize: legendSize,
          }}
        >
          {sublabel !== undefined && sublabel !== null && (
            <Box
              component="span"
              data-keycap-part="sublabel"
              sx={{
                fontSize: `${keycapLabelStack.scale}em`,
                letterSpacing: "0.04em",
                marginBottom: `${keycapLabelStack.gap}em`,
              }}
            >
              {sublabel}
            </Box>
          )}
          {label !== undefined && label !== null && (
            <Box
              component="span"
              data-keycap-part="glyph"
              sx={{ letterSpacing: "0.02em" }}
            >
              {label}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

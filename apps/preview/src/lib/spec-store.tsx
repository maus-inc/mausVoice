/**
 * Live spec store.
 *
 * Overrides are keyed `${entryId}.${fieldKey}` and apply in three ways:
 *  1. palette targets   → scheme-scoped CSS variable overrides (live everywhere)
 *  2. component/duration/easing/shape targets → a derived MUI theme served
 *     through a nested ThemeProvider (live everywhere the real components
 *     read theme values — i.e. all reused components, all instances)
 *  3. recreated targets → useSpecValue() inside recreated components
 *     (live in every recreated instance site-wide)
 * `source` targets are patch-only: the editor shows the exact file/line +
 * copyable patch instead of pretending to live-update a hardcoded value.
 */
import { ThemeProvider } from "@mui/material/styles";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SpecField } from "./registry";
import { REGISTRY } from "./registry";

export type Overrides = Record<string, Record<string, number | string>>;

const STORAGE_KEY = "maus-preview-spec-overrides-v1";

const load = (): Overrides => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch {
    return {};
  }
};

type SpecCtx = {
  overrides: Overrides;
  setOverride: (entryId: string, key: string, value: number | string) => void;
  clearOverride: (entryId: string, key: string) => void;
  resetEntry: (entryId: string) => void;
  resetAll: () => void;
  fieldValue: (entryId: string, field: SpecField) => number | string;
};

const Ctx = createContext<SpecCtx | null>(null);

export const SpecProvider = ({ children }: { children: ReactNode }) => {
  const [overrides, setOverrides] = useState<Overrides>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      /* storage unavailable — session-only */
    }
  }, [overrides]);

  const setOverride = useCallback(
    (entryId: string, key: string, value: number | string) => {
      setOverrides((prev) => ({
        ...prev,
        [entryId]: { ...(prev[entryId] ?? {}), [key]: value },
      }));
    },
    [],
  );

  const clearOverride = useCallback((entryId: string, key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (next[entryId]) {
        const { [key]: _drop, ...rest } = next[entryId];
        if (Object.keys(rest).length === 0) delete next[entryId];
        else next[entryId] = rest;
      }
      return next;
    });
  }, []);

  const resetEntry = useCallback((entryId: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
  }, []);

  const resetAll = useCallback(() => setOverrides({}), []);

  const fieldValue = useCallback(
    (entryId: string, field: SpecField) => {
      const v = overrides[entryId]?.[field.key];
      return v === undefined ? field.default : v;
    },
    [overrides],
  );

  const value = useMemo(
    () => ({ overrides, setOverride, clearOverride, resetEntry, resetAll, fieldValue }),
    [overrides, setOverride, clearOverride, resetEntry, resetAll, fieldValue],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useSpec = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSpec outside SpecProvider");
  return ctx;
};

/** Recreated components read spec values through this so one edit updates
 *  every instance across the whole site. */
export const useSpecValue = <T extends number | string>(
  entryId: string,
  key: string,
  fallback: T,
): T => {
  const { overrides } = useSpec();
  const v = overrides[entryId]?.[key];
  return (v === undefined ? fallback : v) as T;
};

// ─── CSS variable overrides (palette targets) ──────────────────────
// MUI cssVariables mode exposes palette tokens as --app-palette-*
// (see HotKey.tsx pulseBorder using var(--app-palette-blue)).

const tokenToVar = (token: string): string => {
  const parts = token.split(".");
  return `--app-palette-${parts.join("-")}`;
};

export const PaletteOverrideStyle = () => {
  const { overrides } = useSpec();
  const css = useMemo(() => {
    const light: string[] = [];
    const dark: string[] = [];
    for (const entry of REGISTRY) {
      const entryOverrides = overrides[entry.id];
      if (!entryOverrides) continue;
      for (const field of entry.spec) {
        if (field.target.kind !== "palette") continue;
        const v = entryOverrides[field.key];
        if (v === undefined) continue;
        const decl = `${tokenToVar(field.target.token)}: ${v};`;
        if (field.target.scheme === "light" || field.target.scheme === "both")
          light.push(decl);
        if (field.target.scheme === "dark" || field.target.scheme === "both")
          dark.push(decl);
      }
    }
    if (light.length === 0 && dark.length === 0) return "";
    // Broad selectors: MUI's configured colorSchemeSelector is the
    // `data-mui-color-scheme` attribute; cover :root + attribute forms so the
    // override wins regardless of which node carries the scheme.
    return [
      light.length > 0
        ? `:root, [data-mui-color-scheme="light"], html[data-mui-color-scheme="light"] body { ${light.join(" ")} }`
        : "",
      dark.length > 0
        ? `[data-mui-color-scheme="dark"], html[data-mui-color-scheme="dark"] body { ${dark.join(" ")} }`
        : "",
    ].join("\n");
  }, [overrides]);
  if (!css) return null;
  return <style data-preview="palette-overrides">{css}</style>;
};

// ─── Derived theme (component/duration/easing/shape targets) ───────

type ComponentPatch = {
  component: string;
  slot: string;
  nested?: string;
  cssProp: string;
  value: number | string;
};

const collectPatches = (overrides: Overrides) => {
  const componentPatches: ComponentPatch[] = [];
  const durations: Record<string, number> = {};
  const easings: Record<string, string> = {};
  let shapeRadius: number | undefined;
  for (const entry of REGISTRY) {
    const entryOverrides = overrides[entry.id];
    if (!entryOverrides) continue;
    for (const field of entry.spec) {
      const v = entryOverrides[field.key];
      if (v === undefined) continue;
      const t = field.target;
      if (t.kind === "component") {
        componentPatches.push({
          component: t.component,
          slot: t.slot ?? "root",
          nested: t.nested,
          cssProp: t.cssProp,
          value: v,
        });
      } else if (t.kind === "duration") {
        durations[t.token] = Number(v);
      } else if (t.kind === "easing") {
        easings[t.token] = String(v);
      } else if (t.kind === "shape") {
        shapeRadius = Number(v);
      }
    }
  }
  return { componentPatches, durations, easings, shapeRadius };
};

/**
 * Nested provider that derives a patched theme from the outer (real desktop)
 * theme. Original styleOverrides functions are WRAPPED (never replaced), so
 * every token they read still comes from the real theme — only the edited
 * props are overlaid. Because reused components consume the theme, one edit
 * updates every instance on every page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTheme = any;

export const PatchedThemeProvider = ({ children }: { children: ReactNode }) => {
  const { overrides } = useSpec();
  const patches = useMemo(() => collectPatches(overrides), [overrides]);
  const hasPatches =
    patches.componentPatches.length > 0 ||
    Object.keys(patches.durations).length > 0 ||
    Object.keys(patches.easings).length > 0 ||
    patches.shapeRadius !== undefined;

  const derive = useCallback(
    (outer: AnyTheme): AnyTheme => {
      if (!hasPatches) return outer;
      const next: AnyTheme = {
        ...outer,
        shape:
          patches.shapeRadius !== undefined
            ? { ...outer.shape, borderRadius: patches.shapeRadius }
            : outer.shape,
        transitions: {
          ...outer.transitions,
          duration: { ...outer.transitions?.duration, ...patches.durations },
          easing: { ...outer.transitions?.easing, ...patches.easings },
        },
        components: { ...outer.components },
      };
      const byComponent = new Map<string, ComponentPatch[]>();
      for (const p of patches.componentPatches) {
        const list = byComponent.get(p.component) ?? [];
        list.push(p);
        byComponent.set(p.component, list);
      }
      for (const [name, list] of byComponent) {
        const orig = outer.components?.[name] ?? {};
        const origOverrides = orig.styleOverrides ?? {};
        const nextOverrides = { ...origOverrides };
        const bySlot = new Map<string, ComponentPatch[]>();
        for (const p of list) {
          const sl = bySlot.get(p.slot) ?? [];
          sl.push(p);
          bySlot.set(p.slot, sl);
        }
        for (const [slot, slotPatches] of bySlot) {
          const origSlot = origOverrides[slot];
          nextOverrides[slot] = (params: AnyTheme) => {
            const base =
              typeof origSlot === "function"
                ? origSlot(params)
                : ({ ...(origSlot ?? {}) } as Record<string, AnyTheme>);
            const out: Record<string, AnyTheme> = { ...base };
            for (const p of slotPatches) {
              if (p.nested) {
                out[p.nested] = { ...(out[p.nested] ?? {}), [p.cssProp]: p.value };
              } else {
                out[p.cssProp] = p.value;
              }
            }
            return out;
          };
        }
        next.components[name] = { ...orig, styleOverrides: nextOverrides };
      }
      return next;
    },
    [hasPatches, patches],
  );

  // When nothing is overridden, skip the nesting entirely so the real theme
  // object (and its identity) is what components see.
  if (!hasPatches) return <>{children}</>;
  return <ThemeProvider theme={derive}>{children}</ThemeProvider>;
};

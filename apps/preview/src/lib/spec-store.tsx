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
import {
  ThemeProvider,
  type Theme,
  type CSSObject,
  type Interpolation,
} from "@mui/material/styles";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RegistryEntry, SpecField } from "./registry";
import { REGISTRY } from "./registry";

export type Overrides = Record<string, Record<string, number | string>>;

const STORAGE_KEY = "maus-preview-spec-overrides-v1";

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isValidValue = (
  field: SpecField,
  value: unknown,
): value is number | string =>
  typeof value === typeof field.default &&
  (typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)));

const entryOverrides = (entry: RegistryEntry, value: unknown) => {
  const values = recordOf(value);
  if (!values) return {};
  return Object.fromEntries(
    entry.spec.flatMap((field) => {
      const candidate = Object.hasOwn(values, field.key)
        ? values[field.key]
        : undefined;
      return isValidValue(field, candidate) ? [[field.key, candidate]] : [];
    }),
  );
};

const load = (): Overrides => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? recordOf(JSON.parse(raw)) : null;
    if (!stored) return {};
    return Object.fromEntries(
      REGISTRY.flatMap((entry) => {
        const fields = entryOverrides(entry, stored[entry.id]);
        return Object.keys(fields).length ? [[entry.id, fields]] : [];
      }),
    );
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
      const field = REGISTRY.find((entry) => entry.id === entryId)?.spec.find(
        (field) => field.key === key,
      );
      if (!field || !isValidValue(field, value)) return;
      setOverrides((prev) => ({
        ...prev,
        [entryId]: { ...prev[entryId], [key]: value },
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
    () => ({
      overrides,
      setOverride,
      clearOverride,
      resetEntry,
      resetAll,
      fieldValue,
    }),
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

const overriddenFields = (overrides: Overrides) =>
  REGISTRY.flatMap((entry) => {
    const values = overrides[entry.id];
    if (!values) return [];
    return entry.spec.flatMap((field) => {
      const value = values[field.key];
      return value === undefined ? [] : [{ field, value }];
    });
  });

const collectPaletteDecls = (overrides: Overrides) => {
  const light: string[] = [];
  const dark: string[] = [];
  for (const { field, value } of overriddenFields(overrides)) {
    if (field.target.kind !== "palette") continue;
    const decl = `${tokenToVar(field.target.token)}: ${value};`;
    if (field.target.scheme !== "dark") light.push(decl);
    if (field.target.scheme !== "light") dark.push(decl);
  }
  return { light, dark };
};

export const PaletteOverrideStyle = () => {
  const { overrides } = useSpec();
  const css = useMemo(() => {
    const { light, dark } = collectPaletteDecls(overrides);
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
  for (const { field, value } of overriddenFields(overrides)) {
    const t = field.target;
    switch (t.kind) {
      case "component":
        componentPatches.push({
          component: t.component,
          slot: t.slot ?? "root",
          nested: t.nested,
          cssProp: t.cssProp,
          value,
        });
        break;
      case "duration":
        durations[t.token] = Number(value);
        break;
      case "easing":
        easings[t.token] = String(value);
        break;
      case "shape":
        shapeRadius = Number(value);
        break;
    }
  }
  return { componentPatches, durations, easings, shapeRadius };
};

type StyleParams = { theme: Theme; ownerState: Record<string, unknown> };
type StyleOverrides = Record<string, Interpolation<StyleParams>>;
type PreviewComponent = { styleOverrides?: StyleOverrides };

const patchSlots = (original: StyleOverrides, patches: ComponentPatch[]) => {
  const additions: Record<string, CSSObject> = {};
  for (const patch of patches) {
    const slot = (additions[patch.slot] ??= {});
    if (patch.nested) {
      const nested = slot[patch.nested] as CSSObject | undefined;
      slot[patch.nested] = { ...nested, [patch.cssProp]: patch.value };
    } else {
      slot[patch.cssProp] = patch.value;
    }
  }
  const next = { ...original };
  for (const [slot, addition] of Object.entries(additions)) {
    // MUI interpolations may be functions or arrays. Layer overrides rather
    // than spreading them into objects and losing their rendering behavior.
    next[slot] = [original[slot], addition];
  }
  return next;
};

const patchComponents = (outer: Theme, patches: ComponentPatch[]) => {
  const byComponent = new Map<string, ComponentPatch[]>();
  for (const patch of patches) {
    const list = byComponent.get(patch.component) ?? [];
    list.push(patch);
    byComponent.set(patch.component, list);
  }
  // Registry entries select component and slot names dynamically. Keep that
  // boundary here instead of making the entire theme untyped.
  const components = { ...outer.components } as Record<
    string,
    PreviewComponent
  >;
  for (const [name, list] of byComponent) {
    const original = components[name];
    components[name] = {
      ...original,
      styleOverrides: patchSlots(original?.styleOverrides ?? {}, list),
    };
  }
  return components as Theme["components"];
};

export const PatchedThemeProvider = ({ children }: { children: ReactNode }) => {
  const { overrides } = useSpec();
  const patches = useMemo(() => collectPatches(overrides), [overrides]);
  const hasPatches =
    patches.componentPatches.length > 0 ||
    Object.keys(patches.durations).length > 0 ||
    Object.keys(patches.easings).length > 0 ||
    patches.shapeRadius !== undefined;

  const derive = useCallback(
    (outer: Theme): Theme => {
      if (!hasPatches) return outer;
      const next: Theme = {
        ...outer,
        shape:
          patches.shapeRadius !== undefined
            ? { ...outer.shape, borderRadius: patches.shapeRadius }
            : outer.shape,
        transitions: {
          ...outer.transitions,
          duration: { ...outer.transitions.duration, ...patches.durations },
          easing: { ...outer.transitions.easing, ...patches.easings },
        },
        components: patchComponents(outer, patches.componentPatches),
      };
      return next;
    },
    [hasPatches, patches],
  );

  // When nothing is overridden, skip the nesting entirely so the real theme
  // object (and its identity) is what components see.
  if (!hasPatches) return <>{children}</>;
  return <ThemeProvider theme={derive}>{children}</ThemeProvider>;
};

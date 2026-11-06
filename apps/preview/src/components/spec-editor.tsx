/**
 * Live spec editor. Each field edits ONE value that propagates everywhere:
 * palette/component/duration/easing/shape targets patch the theme + CSS vars
 * (all reused instances update); recreated targets flow through useSpecValue
 * (all recreated instances update). Source targets are patch-only and show
 * the exact file/line + copyable patch plus every affected real-app path.
 */
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import {
  Box,
  Button,
  Chip,
  MenuItem,
  Select,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { RegistryEntry, SpecField } from "../lib/registry";
import { useSpec } from "../lib/spec-store";

const isLive = (f: SpecField) => f.target.kind !== "source";

// Numeric spec controls share bounds, a slider, and a unit label.
const NumericSpecControl = ({
  field,
  value,
  onChange,
}: {
  field: SpecField;
  value: number | string;
  onChange: (value: number) => void;
}) => {
  const num = Number(value);
  return (
    <Stack
      direction="row"
      spacing={2}
      sx={{ alignItems: "center", minWidth: 220 }}
    >
      <Slider
        size="small"
        value={Number.isFinite(num) ? num : Number(field.default)}
        min={field.min ?? 0}
        max={field.max ?? 100}
        step={field.step ?? 1}
        onChange={(_, v) => onChange(Number(v))}
        sx={{ width: 140 }}
        aria-label={field.label}
      />
      <Typography
        variant="bodySmall"
        sx={{ fontFamily: "monospace", minWidth: 64 }}
      >
        {String(value)}
        {field.unit ?? ""}
      </Typography>
    </Stack>
  );
};

const FieldControl = ({
  entryId,
  field,
}: {
  entryId: string;
  field: SpecField;
}) => {
  const { fieldValue, setOverride } = useSpec();
  const value = fieldValue(entryId, field);
  const live = isLive(field);

  if (!live) {
    return (
      <Typography variant="bodySmall" color="text.secondary">
        Spec value: <code>{String(field.default)}</code>
      </Typography>
    );
  }

  if (field.type === "color") {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Box
          component="input"
          type="color"
          value={String(value).slice(0, 7)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setOverride(entryId, field.key, e.target.value)
          }
          sx={{
            width: 36,
            height: 28,
            p: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
          }}
          aria-label={field.label}
        />
        <TextField
          size="small"
          value={String(value)}
          onChange={(e) => setOverride(entryId, field.key, e.target.value)}
          sx={{ width: 130 }}
          slotProps={{
            input: { "aria-label": `${field.label} hex`, spellCheck: false },
          }}
        />
      </Stack>
    );
  }

  if (field.type === "easing" || field.type === "select") {
    return (
      <Select
        size="small"
        value={String(value)}
        onChange={(e) => setOverride(entryId, field.key, e.target.value)}
        sx={{ minWidth: 220, maxWidth: "100%" }}
      >
        {(field.options ?? []).map((o) => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </Select>
    );
  }

  if (field.type === "text") {
    return (
      <TextField
        size="small"
        value={String(value)}
        onChange={(e) => setOverride(entryId, field.key, e.target.value)}
        sx={{ minWidth: 220 }}
      />
    );
  }

  return (
    <NumericSpecControl
      field={field}
      value={value}
      onChange={(next) => setOverride(entryId, field.key, next)}
    />
  );
};

const writeClipboard = async (
  text: string,
  isCurrent: () => boolean,
): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!isCurrent()) return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand("copy"); // NOSONAR: legacy clipboard fallback.
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
};

const useCopyFeedback = (patch: string) => {
  const [copiedPatch, setCopiedPatch] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setCopiedPatch(null);
    return () => {
      generation.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [patch]);

  const copy = async () => {
    const current = ++generation.current;
    if (
      !(await writeClipboard(patch, () => generation.current === current)) ||
      generation.current !== current
    )
      return;
    setCopiedPatch(patch);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopiedPatch(null);
    }, 1500);
  };
  return { copied: copiedPatch === patch, copy };
};

const SpecFieldHeader = ({
  label,
  live,
  edited,
  copied,
  onReset,
  onCopy,
}: {
  label: string;
  live: boolean;
  edited: boolean;
  copied: boolean;
  onReset: () => void;
  onCopy: () => void;
}) => (
  <Stack
    direction="row"
    spacing={1}
    sx={{ alignItems: "center", mb: 1, flexWrap: "wrap" }}
  >
    <Typography variant="labelMedium">{label}</Typography>
    <Chip
      size="small"
      label={live ? "live" : "patch-only"}
      color={live ? "success" : "default"}
      variant={live ? "filled" : "outlined"}
    />
    {edited && (
      <Chip size="small" label="edited" color="primary" variant="outlined" />
    )}
    <Box sx={{ flex: 1 }} />
    {edited && (
      <Tooltip title="Reset to spec default">
        <Button
          size="small"
          variant="text"
          startIcon={<RestartAltIcon />}
          onClick={onReset}
        >
          Reset
        </Button>
      </Tooltip>
    )}
    <Tooltip title="Copy patch snippet">
      <Button
        size="small"
        variant="text"
        startIcon={<ContentCopyIcon />}
        onClick={onCopy}
      >
        {copied ? "Copied" : "Patch"}
      </Button>
    </Tooltip>
  </Stack>
);

const SpecFieldRow = ({
  entry,
  field,
}: {
  entry: RegistryEntry;
  field: SpecField;
}) => {
  const { fieldValue, clearOverride, overrides } = useSpec();
  const live = isLive(field);
  const edited = overrides[entry.id]?.[field.key] !== undefined;
  const patch =
    field.patch ?? `// ${field.mapsTo}\n// default: ${String(field.default)}`;

  const { copied, copy } = useCopyFeedback(patch);

  return (
    <Box sx={{ py: 2, borderBottom: "1px solid", borderColor: "divider" }}>
      <SpecFieldHeader
        label={field.label}
        live={live}
        edited={edited}
        copied={copied}
        onReset={() => clearOverride(entry.id, field.key)}
        onCopy={copy}
      />
      <FieldControl entryId={entry.id} field={field} />
      {field.help && (
        <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 0.5 }}>
          {field.help}
        </Typography>
      )}
      <Typography
        variant="bodySmall"
        color="text.secondary"
        sx={{ mt: 0.5, fontFamily: "monospace", fontSize: 11.5 }}
      >
        → {field.mapsTo}
      </Typography>
      {edited && (
        <Typography variant="bodySmall" sx={{ mt: 0.5 }}>
          Spec: <code>{String(field.default)}</code> → now:{" "}
          <code>{String(fieldValue(entry.id, field))}</code>
        </Typography>
      )}
    </Box>
  );
};

export const SpecEditor = ({ entry }: { entry: RegistryEntry }) => {
  const { resetEntry, overrides } = useSpec();
  const editedCount = Object.keys(overrides[entry.id] ?? {}).length;
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="titleSmall">Spec editor</Typography>
        <Box sx={{ flex: 1 }} />
        {editedCount > 0 && (
          <Button
            size="small"
            variant="text"
            startIcon={<RestartAltIcon />}
            onClick={() => resetEntry(entry.id)}
          >
            Reset all ({editedCount})
          </Button>
        )}
      </Stack>
      <Typography variant="bodySmall" color="text.secondary">
        Live fields update every instance site-wide immediately. Patch-only
        fields are hardcoded at the call site — copy the patch and apply it to
        the real-app files listed below.
      </Typography>
      {entry.spec.map((f) => (
        <SpecFieldRow key={f.key} entry={entry} field={f} />
      ))}
      <Box sx={{ mt: 2 }}>
        <Typography variant="labelMedium" sx={{ display: "block", mb: 0.5 }}>
          Real-app files affected by a spec change
        </Typography>
        {entry.usedIn.map((p) => (
          <Typography
            key={p}
            variant="bodySmall"
            sx={{ fontFamily: "monospace", fontSize: 11.5, display: "block" }}
          >
            {p}
          </Typography>
        ))}
      </Box>
    </Box>
  );
};

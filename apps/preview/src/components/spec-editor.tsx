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
import { useState } from "react";
import type { RegistryEntry, SpecField } from "../lib/registry";
import { useSpec } from "../lib/spec-store";

const isLive = (f: SpecField) => f.target.kind !== "source";

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
          sx={{ width: 36, height: 28, p: 0, border: "none", background: "none", cursor: "pointer" }}
          aria-label={field.label}
        />
        <TextField
          size="small"
          value={String(value)}
          onChange={(e) => setOverride(entryId, field.key, e.target.value)}
          sx={{ width: 130 }}
          slotProps={{ input: { "aria-label": `${field.label} hex`, spellCheck: false } }}
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

  // numeric (radius / duration / opacity / number)
  const num = Number(value);
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center", minWidth: 220 }}>
      <Slider
        size="small"
        value={Number.isFinite(num) ? num : Number(field.default)}
        min={field.min ?? 0}
        max={field.max ?? 100}
        step={field.step ?? 1}
        onChange={(_, v) => setOverride(entryId, field.key, Number(v))}
        sx={{ width: 140 }}
        aria-label={field.label}
      />
      <Typography variant="bodySmall" sx={{ fontFamily: "monospace", minWidth: 64 }}>
        {String(value)}
        {field.unit ?? ""}
      </Typography>
    </Stack>
  );
};

const SpecFieldRow = ({ entry, field }: { entry: RegistryEntry; field: SpecField }) => {
  const { fieldValue, clearOverride, overrides } = useSpec();
  const [copied, setCopied] = useState(false);
  const live = isLive(field);
  const edited = overrides[entry.id]?.[field.key] !== undefined;
  const patch = field.patch ?? `// ${field.mapsTo}\n// default: ${String(field.default)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(patch);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = patch;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Box sx={{ py: 2, borderBottom: "1px solid", borderColor: "divider" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1, flexWrap: "wrap" }}>
        <Typography variant="labelMedium">{field.label}</Typography>
        <Chip size="small" label={live ? "live" : "patch-only"} color={live ? "success" : "default"} variant={live ? "filled" : "outlined"} />
        {edited && <Chip size="small" label="edited" color="primary" variant="outlined" />}
        <Box sx={{ flex: 1 }} />
        {edited && (
          <Tooltip title="Reset to spec default">
            <Button size="small" variant="text" startIcon={<RestartAltIcon />} onClick={() => clearOverride(entry.id, field.key)}>
              Reset
            </Button>
          </Tooltip>
        )}
        <Tooltip title="Copy patch snippet">
          <Button size="small" variant="text" startIcon={<ContentCopyIcon />} onClick={copy}>
            {copied ? "Copied" : "Patch"}
          </Button>
        </Tooltip>
      </Stack>
      <FieldControl entryId={entry.id} field={field} />
      {field.help && (
        <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 0.5 }}>
          {field.help}
        </Typography>
      )}
      <Typography variant="bodySmall" color="text.secondary" sx={{ mt: 0.5, fontFamily: "monospace", fontSize: 11.5 }}>
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
          <Button size="small" variant="text" startIcon={<RestartAltIcon />} onClick={() => resetEntry(entry.id)}>
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
          <Typography key={p} variant="bodySmall" sx={{ fontFamily: "monospace", fontSize: 11.5, display: "block" }}>
            {p}
          </Typography>
        ))}
      </Box>
    </Box>
  );
};

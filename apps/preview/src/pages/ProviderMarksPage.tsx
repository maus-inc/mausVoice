/**
 * A verification page, not a design surface: it mounts the real settings
 * components that show provider marks, with the store seeded, so the marks can
 * be screenshotted where they actually live instead of only in the demo
 * matrix. It is reachable at `#/provider-marks` and is deliberately not in the
 * registry — the registry is the design index, and this is a fixture for
 * checking that the app surfaces render what the demo promises.
 */
import { Box, Paper, Typography, Divider } from "@mui/material";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ApiKeyList } from "@desktop/components/settings/ApiKeyList";
import { PersonalApiKeyDialog } from "@desktop/components/settings/PersonalApiKeyDialog";
import { YourModelsCard } from "@desktop/components/settings/home/YourModelsCard";
import { ProviderLogo } from "@desktop/components/common/provider-logos/ProviderLogo";
import { AudioTransmissionDisclosure } from "@desktop/components/settings/AudioTransmissionDisclosure";
import { produceAppState } from "@desktop/store";
import type { AppState } from "@desktop/state/app.state";
import {
  INITIAL_SETTINGS_STATE,
  type SettingsApiKey,
} from "@desktop/state/settings.state";

/**
 * Seeded with `keyFull` as well as `keySuffix`: the overview card reads the
 * resolved prefs, and a key row with no credential resolves to "not
 * configured", which renders the generic job glyph instead of the mark this
 * fixture exists to check.
 */
const KEYS: SettingsApiKey[] = [
  {
    id: "k-groq",
    name: "Groq key",
    provider: "groq",
    createdAt: "2026-01-01T00:00:00.000Z",
    keyFull: "gsk_fixture_groq",
    keySuffix: "9f2a",
  },
  {
    id: "k-deepgram",
    name: "Deepgram key",
    provider: "deepgram",
    createdAt: "2026-01-02T00:00:00.000Z",
    keyFull: "dg_fixture_deepgram",
    keySuffix: "4c7d",
  },
  {
    id: "k-assembly",
    name: "AssemblyAI key",
    provider: "assemblyai",
    createdAt: "2026-01-03T00:00:00.000Z",
    keyFull: "aai_fixture_assembly",
    keySuffix: "7a10",
  },
  {
    id: "k-openrouter",
    name: "OpenRouter key",
    provider: "openrouter",
    createdAt: "2026-01-04T00:00:00.000Z",
    keyFull: "sk-or_fixture_openrouter",
    keySuffix: "11be",
  },
  {
    id: "k-eleven",
    name: "ElevenLabs key",
    provider: "elevenlabs",
    createdAt: "2026-01-05T00:00:00.000Z",
    keyFull: "xi_fixture_eleven",
    keySuffix: "3f88",
  },
  {
    id: "k-gladia",
    name: "Gladia key",
    provider: "gladia",
    createdAt: "2026-01-06T00:00:00.000Z",
    keyFull: "gladia_fixture_key",
    keySuffix: "c401",
  },
  {
    id: "k-ollama",
    name: "Ollama",
    provider: "ollama",
    createdAt: "2026-01-07T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:11434",
  },
  {
    id: "k-xai",
    name: "xAI key",
    provider: "xai",
    createdAt: "2026-01-08T00:00:00.000Z",
  },
];

const seed = () => {
  produceAppState((draft) => {
    draft.settings = {
      ...INITIAL_SETTINGS_STATE,
      apiKeys: KEYS,
      apiKeysStatus: "success",
    };
    draft.apiKeyById = Object.fromEntries(
      KEYS.map((key) => [key.id, { ...key, userId: "u1" }]),
    ) as AppState["apiKeyById"];
    draft.settings.aiTranscription = {
      ...draft.settings.aiTranscription,
      mode: "api",
      selectedApiKeyId: "k-assembly",
    };
    draft.settings.aiPostProcessing = {
      ...draft.settings.aiPostProcessing,
      mode: "api",
      selectedApiKeyId: "k-openrouter",
    };
    // Assistant mode reads the same key table, so it gets its own provider: three
    // rows, three different marks, which is the point of the card.
    draft.settings.agentMode = {
      ...draft.settings.agentMode,
      mode: "api",
      selectedApiKeyId: "k-groq",
    };
  });
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <Box sx={{ mb: 4 }}>
    <Typography variant="labelMedium" component="h2" sx={{ mb: 1 }}>
      {title}
    </Typography>
    {children}
  </Box>
);

/**
 * `#/provider-marks?dialog=deepgram` mounts the personal-key dialog over the
 * page. It is a query rather than a second route so the fixture stays one
 * component: the dialog's backdrop dims everything behind it, and a reviewer
 * wants to look at it against the real page, not in isolation.
 */
const DIALOG_PROVIDERS = ["deepgram", "groq"] as const;
type DialogProvider = (typeof DIALOG_PROVIDERS)[number];

const readDialogProvider = (search: string): DialogProvider | null => {
  const value = new URLSearchParams(search).get("dialog");
  return DIALOG_PROVIDERS.find((provider) => provider === value) ?? null;
};

export const ProviderMarksPage = () => {
  const { search } = useLocation();
  const dialogProvider = readDialogProvider(search);

  useEffect(() => {
    seed();
  }, []);

  return (
    <Box sx={{ p: 3, maxWidth: 780 }}>
      <Typography variant="titleMedium" component="h1" sx={{ mb: 0.5 }}>
        Provider marks in the real surfaces
      </Typography>
      <Typography
        variant="bodySmall"
        component="p"
        sx={{ color: "text.secondary", mb: 3 }}
      >
        Fixtures at `#/provider-marks` — the settings components themselves,
        with the store seeded, so the marks can be checked where they ship.
      </Typography>

      <Section title="ApiKeyList · post-processing (key cards)">
        <ApiKeyList
          selectedApiKeyId="k-openrouter"
          onChange={() => undefined}
          context="post-processing"
        />
      </Section>

      <Section title="ApiKeyList · transcription, compact cards">
        <ApiKeyList
          selectedApiKeyId="k-assembly"
          onChange={() => undefined}
          context="transcription"
          compactCards
        />
      </Section>

      <Section title="Your models (Overview card)">
        <Paper variant="outlined" sx={{ p: 2 }}>
          <YourModelsCard />
        </Paper>
      </Section>

      <Section title="Audio transmission disclosure">
        <AudioTransmissionDisclosure />
        <Divider sx={{ my: 2 }} />
        <AudioTransmissionDisclosure variant="setting" />
      </Section>

      {dialogProvider && (
        <Section title={`PersonalApiKeyDialog · ${dialogProvider}`}>
          <PersonalApiKeyDialog
            provider={dialogProvider}
            open
            onClose={() => undefined}
          />
        </Section>
      )}

      <Section title="Every mark at the sizes the surfaces use">
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {[14, 16, 18, 20, 22].map((size) => (
            <Box
              key={size}
              sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
            >
              <ProviderLogo provider="deepgram" size={size} />
              <ProviderLogo provider="openai" size={size} />
              <ProviderLogo provider="gladia" size={size} />
              <ProviderLogo provider="openrouter" size={size} />
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", ml: 0.5 }}
              >
                {size}px
              </Typography>
            </Box>
          ))}
        </Box>
      </Section>
    </Box>
  );
};

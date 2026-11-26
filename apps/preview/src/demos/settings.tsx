/** Settings row demos — the real `SettingRow` chassis in both themes. */
import {
  ChartColumn,
  CloudUpload,
  Eraser,
  Globe,
  Hourglass,
  Mic,
  Trash2,
  Volume2,
} from "lucide-react";
import { Box, Chip, Stack } from "@mui/material";
import { useState } from "react";
import {
  SettingGroup,
  SettingRow,
  SettingToggleRow,
} from "@desktop/components/settings/SettingRow";
import { settingGlyphProps } from "@desktop/components/settings/setting-row-chassis";
import { DemoSection, Matrix, State } from "../components/demo-ui";

/**
 * The settings row, in the shapes a page actually mixes.
 *
 * The matrix exists for one reason: a page alternates a row that opens a
 * dialog, a row that holds a control, a row that reports a value and a switch
 * row inside a single card, and the icon lane is what makes those four read as
 * one list. Seen one shape at a time, a row looks fine with no glyph at all.
 */
export const SettingsRowDemo = () => {
  const [spokenCommands, setSpokenCommands] = useState(true);
  const [streaming, setStreaming] = useState(false);

  return (
    <DemoSection
      title="SettingRow · SettingToggleRow"
      hint="Every row leads with a 22px lucide glyph at stroke 1.9 in a fixed lane, so titles align whether the leading mark is a glyph, a provider logo or an avatar. The glyph is aria-hidden: the title is the row's name, not the glyph."
    >
      <Matrix>
        <State label="opens a dialog · holds a control · reports a value" wide>
          <Box sx={{ width: "100%", maxWidth: 620 }}>
            <SettingGroup title="Dictation">
              <SettingRow
                settingKey="preview_microphone"
                title="Microphone"
                description="Which input captures your voice, and how it is tested."
                icon={<Mic {...settingGlyphProps} />}
                onClick={() => undefined}
              />
              <SettingRow
                settingKey="preview_language"
                title="Dictation language"
                description="The language mausVoice expects to hear."
                icon={<Globe {...settingGlyphProps} />}
                value="English (US)"
              />
              <SettingRow
                settingKey="preview_limit"
                title="Dictation limit"
                description="Stops a recording that runs too long."
                icon={<Hourglass {...settingGlyphProps} />}
                value="5 minutes"
              />
            </SettingGroup>
          </Box>
        </State>
        <State label="switch rows share the same lane" wide>
          <Box sx={{ width: "100%", maxWidth: 620 }}>
            <SettingGroup title="Behaviour">
              <SettingToggleRow
                settingKey="preview_spoken_commands"
                title="Spoken commands"
                description="Turns phrases like new line and comma into formatting."
                icon={<Mic {...settingGlyphProps} />}
                checked={spokenCommands}
                onChange={(event) => setSpokenCommands(event.target.checked)}
              />
              <SettingToggleRow
                settingKey="preview_streaming"
                title="Real-time output"
                description="Streams dictation text as you speak instead of pasting it when you stop."
                icon={<Volume2 {...settingGlyphProps} />}
                checked={streaming}
                onChange={(event) => setStreaming(event.target.checked)}
              />
            </SettingGroup>
          </Box>
        </State>
        <State label="destructive row (iconTone danger)" wide>
          <Box sx={{ width: "100%", maxWidth: 620 }}>
            <SettingGroup title="Danger zone" danger>
              <SettingRow
                settingKey="preview_clear_data"
                title="Clear local data"
                description="Removes stored history, audio snapshots, your photo and settings from this computer."
                icon={<Eraser {...settingGlyphProps} />}
                iconTone="danger"
                action={{ label: "Clear data", tone: "error" }}
                onClick={() => undefined}
              />
              <SettingRow
                settingKey="preview_delete_account"
                title="Delete account"
                description="Deletes your profile and everything mausVoice stores for you on this device."
                icon={<Trash2 {...settingGlyphProps} />}
                iconTone="danger"
                action={{ label: "Delete", tone: "error" }}
                onClick={() => undefined}
              />
            </SettingGroup>
          </Box>
        </State>
        <State label="wide control wraps below the label block, glyph included">
          <Box sx={{ width: "100%", maxWidth: 420 }}>
            <SettingGroup title="Providers">
              <SettingRow
                settingKey="preview_audio_route"
                title="Where your dictation audio goes"
                description="A provider key turns streaming on."
                icon={<CloudUpload {...settingGlyphProps} />}
                control={
                  <Stack direction="row" spacing={0.75}>
                    <Chip size="small" label="Deepgram" />
                    <Chip size="small" label="Groq" />
                  </Stack>
                }
              />
            </SettingGroup>
          </Box>
        </State>
        <State label="long title, narrow card">
          <Box sx={{ width: "100%", maxWidth: 340 }}>
            <SettingGroup title="Privacy">
              <SettingToggleRow
                settingKey="preview_usage"
                title="Share anonymous usage counts so the team knows which features are used"
                description="No transcript, audio or key ever leaves this computer."
                icon={<ChartColumn {...settingGlyphProps} />}
                checked={false}
                onChange={() => undefined}
              />
            </SettingGroup>
          </Box>
        </State>
      </Matrix>
    </DemoSection>
  );
};

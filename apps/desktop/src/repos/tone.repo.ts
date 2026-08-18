import { Tone } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import { getLogger } from "../utils/log.utils";
import { getDefaultSystemTones } from "../utils/tone.utils";
import { BaseRepo } from "./base.repo";

type LocalTone = {
  id: string;
  name: string;
  promptTemplate: string;
  createdAt: number;
  sortOrder: number;
  category?: string | null;
  outputLength?: string | null;
  exampleInputOutput?: string | null;
};

const fromLocalTone = (tone: LocalTone): Tone => ({
  id: tone.id,
  name: tone.name,
  promptTemplate: tone.promptTemplate,
  isSystem: false,
  createdAt: tone.createdAt,
  sortOrder: tone.sortOrder,
  category: tone.category ?? undefined,
  outputLength: tone.outputLength ?? undefined,
  exampleInputOutput: tone.exampleInputOutput ?? undefined,
});

const toLocalTone = (tone: Tone): LocalTone => ({
  id: tone.id,
  name: tone.name,
  promptTemplate: tone.promptTemplate,
  createdAt: tone.createdAt,
  sortOrder: tone.sortOrder,
  category: tone.category ?? null,
  outputLength: tone.outputLength ?? null,
  exampleInputOutput: tone.exampleInputOutput ?? null,
});

const getSystemToneById = (id: string): Tone | undefined =>
  getDefaultSystemTones().find((tone) => tone.id === id);

const mergeSystemTones = (userTones: Tone[]): Tone[] => {
  const systemTones = getDefaultSystemTones();
  const combined = [...systemTones, ...userTones];
  return combined.sort((left, right) => left.sortOrder - right.sortOrder);
};

export abstract class BaseToneRepo extends BaseRepo {
  protected abstract listTonesInternal(): Promise<Tone[]>;
  protected abstract getToneInternal(id: string): Promise<Tone | null>;
  protected abstract upsertToneInternal(tone: Tone): Promise<Tone>;
  protected abstract deleteToneInternal(id: string): Promise<void>;

  async listTones(): Promise<Tone[]> {
    // The remote tone-overrides fetch (a mausVoice Cloud feature) was removed
    // in 0.1.6: built-in and user-defined styles are used as-is.
    const userTones = await this.listTonesInternal().catch((error) => {
      getLogger().warning(
        `Failed to load user-defined styles, falling back to built-in styles: ${error}`,
      );
      return [];
    });

    return mergeSystemTones(userTones);
  }

  async getTone(id: string): Promise<Tone | null> {
    const systemTone = getSystemToneById(id);
    if (systemTone) {
      return systemTone;
    }
    return this.getToneInternal(id);
  }

  async upsertTone(tone: Tone): Promise<Tone> {
    if (tone.isSystem) {
      throw new Error("System tones cannot be modified.");
    }
    return this.upsertToneInternal(tone);
  }

  async deleteTone(id: string): Promise<void> {
    if (getSystemToneById(id)) {
      throw new Error("System tones cannot be deleted.");
    }
    return this.deleteToneInternal(id);
  }
}

export class LocalToneRepo extends BaseToneRepo {
  protected async listTonesInternal(): Promise<Tone[]> {
    const tones = await invoke<LocalTone[]>("tone_list");
    return tones.map(fromLocalTone);
  }

  protected async getToneInternal(id: string): Promise<Tone | null> {
    const tone = await invoke<LocalTone | null>("tone_get", { id });
    return tone ? fromLocalTone(tone) : null;
  }

  protected async upsertToneInternal(tone: Tone): Promise<Tone> {
    const upserted = await invoke<LocalTone>("tone_upsert", {
      tone: toLocalTone(tone),
    });
    return fromLocalTone(upserted);
  }

  protected async deleteToneInternal(id: string): Promise<void> {
    await invoke("tone_delete", { id });
  }
}

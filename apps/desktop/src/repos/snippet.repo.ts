import { invoke } from "@tauri-apps/api/core";
import type { Snippet, SnippetVariable } from "../types/snippets.types";
import { BaseRepo } from "./base.repo";

type LocalSnippet = {
  id: string;
  trigger: string;
  body: string;
  variables: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

const fromLocalSnippet = (local: LocalSnippet): Snippet => ({
  id: local.id,
  trigger: local.trigger,
  body: local.body,
  variables: JSON.parse(local.variables) as SnippetVariable[],
  enabled: local.enabled,
  createdAt: new Date(local.createdAt).toISOString(),
  updatedAt: new Date(local.updatedAt).toISOString(),
});

export type CreateSnippetParams = {
  id: string;
  trigger: string;
  body: string;
  variables: SnippetVariable[];
  enabled: boolean;
};

export abstract class BaseSnippetRepo extends BaseRepo {
  abstract createSnippet(params: CreateSnippetParams): Promise<Snippet>;
  abstract listSnippets(): Promise<Snippet[]>;
  abstract updateSnippet(params: CreateSnippetParams): Promise<Snippet>;
  abstract deleteSnippet(id: string): Promise<void>;
  abstract getSnippetByTrigger(trigger: string): Promise<Snippet | null>;
}

export class LocalSnippetRepo extends BaseSnippetRepo {
  async createSnippet(params: CreateSnippetParams): Promise<Snippet> {
    const created = await invoke<LocalSnippet>("snippet_create", {
      args: {
        id: params.id,
        trigger: params.trigger,
        body: params.body,
        variables: params.variables,
        enabled: params.enabled,
      },
    });
    return fromLocalSnippet(created);
  }

  async listSnippets(): Promise<Snippet[]> {
    const stored = await invoke<LocalSnippet[]>("snippet_list");
    return stored.map(fromLocalSnippet);
  }

  async updateSnippet(params: CreateSnippetParams): Promise<Snippet> {
    const updated = await invoke<LocalSnippet>("snippet_update", {
      args: {
        id: params.id,
        trigger: params.trigger,
        body: params.body,
        variables: params.variables,
        enabled: params.enabled,
      },
    });
    return fromLocalSnippet(updated);
  }

  async deleteSnippet(id: string): Promise<void> {
    await invoke<void>("snippet_delete", { id });
  }

  async getSnippetByTrigger(_trigger: string): Promise<Snippet | null> {
    const snippets = await this.listSnippets();
    return snippets.find((s) => s.trigger === _trigger) ?? null;
  }
}

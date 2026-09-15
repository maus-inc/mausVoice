import { getSnippetRepo, getWebhookRepo } from "../repos";
import type { Snippet } from "../types/snippets.types";
import { createId } from "../utils/id.utils";
import { isExpansionFeatureEnabled } from "../features/featureFlags";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { expandSnippet } from "../utils/snippets.utils";
import { getLogger } from "../utils/log.utils";

const ensureTranslationsOrSnippetEnabled = (): void => {
  // Snippets reuse translationsEnabled gate until a dedicated flag ships; both
  // live under the same pole and share the history/clear path.
  if (!isExpansionFeatureEnabled("translationsEnabled")) {
    throw new Error("Snippets feature is not enabled");
  }
};

const ensurePersistenceAllowed = (): void => {
  if (!isPersistenceAllowed()) {
    throw new Error("Persistence is suppressed in incognito mode");
  }
};

export const createSnippet = async (params: {
  trigger: string;
  body: string;
  variables: Snippet["variables"];
  enabled?: boolean;
}): Promise<Snippet> => {
  ensureTranslationsOrSnippetEnabled();
  ensurePersistenceAllowed();
  const repo = getSnippetRepo();
  return repo.createSnippet({
    id: createId(),
    trigger: params.trigger,
    body: params.body,
    variables: params.variables,
    enabled: params.enabled ?? true,
  });
};

export const listSnippets = async (): Promise<Snippet[]> => {
  ensureTranslationsOrSnippetEnabled();
  return getSnippetRepo().listSnippets();
};

export const updateSnippet = async (snippet: Snippet): Promise<Snippet> => {
  ensureTranslationsOrSnippetEnabled();
  ensurePersistenceAllowed();
  return getSnippetRepo().updateSnippet({
    id: snippet.id,
    trigger: snippet.trigger,
    body: snippet.body,
    variables: snippet.variables,
    enabled: snippet.enabled,
  });
};

export const deleteSnippet = async (id: string): Promise<void> => {
  ensureTranslationsOrSnippetEnabled();
  ensurePersistenceAllowed();
  await getSnippetRepo().deleteSnippet(id);
};

export const expandSnippetByTrigger = async (params: {
  trigger: string;
  variableValues: Record<string, string>;
  clipboardText?: string;
}): Promise<string> => {
  ensureTranslationsOrSnippetEnabled();
  const repo = getSnippetRepo();
  const snippet = await repo.getSnippetByTrigger(params.trigger);
  if (!snippet) {
    throw new Error(`Snippet not found for trigger ${params.trigger}`);
  }
  if (!snippet.enabled) {
    throw new Error(`Snippet ${params.trigger} is disabled`);
  }
  const expanded = expandSnippet(
    snippet,
    params.variableValues,
    params.clipboardText ?? "",
  );
  try {
    await getWebhookRepo().emitEvent("snippet.expanded", {
      trigger: snippet.trigger,
      id: snippet.id,
    });
  } catch (error) {
    getLogger().warning(
      `Snippet webhook emit failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return expanded;
};

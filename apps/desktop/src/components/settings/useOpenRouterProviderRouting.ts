import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenRouterProviderRouting } from "@maus-inc/types";
import {
  getOpenRouterConfigForKey,
  loadOpenRouterProviders,
  updateOpenRouterProviderRouting,
} from "../../actions/openrouter.actions";
import { useAppStore } from "../../store";

export const useOpenRouterProviderRouting = (
  apiKeyId: string,
  disabled: boolean,
) => {
  const [expanded, setExpanded] = useState(false);

  // Get providers from state
  const providers = useAppStore((state) => state.settings.openRouterProviders);
  const providersStatus = useAppStore(
    (state) => state.settings.openRouterProvidersStatus,
  );

  // Load providers when expanded
  useEffect(() => {
    if (expanded && providersStatus === "idle") {
      void loadOpenRouterProviders();
    }
  }, [expanded, providersStatus]);

  // Get current config
  const config = getOpenRouterConfigForKey(apiKeyId);
  const routing = config?.providerRouting ?? {};

  const providerOrder = routing.order ?? [];
  const allowFallbacks = routing.allow_fallbacks ?? true;
  const dataCollection = routing.data_collection ?? "allow";

  // Available providers not yet in the order list
  const availableToAdd = useMemo(() => {
    return providers.filter((p) => !providerOrder.includes(p.slug));
  }, [providers, providerOrder]);

  // Helper to get provider name by slug
  const getProviderName = useCallback(
    (slug: string) => {
      const provider = providers.find((p) => p.slug === slug);
      return provider?.name ?? slug;
    },
    [providers],
  );

  // Summary for collapsed state
  const summary = useMemo(() => {
    if (providerOrder.length === 0) {
      return null;
    }
    const names = providerOrder.map(getProviderName);
    if (names.length <= 2) {
      return names.join(", ");
    }
    return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  }, [providerOrder, getProviderName]);

  const handleToggleExpand = useCallback(() => {
    if (!disabled) {
      setExpanded((prev) => !prev);
    }
  }, [disabled]);

  const changes = useProviderRoutingChanges(apiKeyId, routing, providerOrder);

  return {
    expanded,
    providerOrder,
    allowFallbacks,
    dataCollection,
    availableToAdd,
    getProviderName,
    summary,
    handleToggleExpand,
    ...changes,
  };
};

const useProviderRoutingChanges = (
  apiKeyId: string,
  routing: OpenRouterProviderRouting,
  providerOrder: string[],
) => {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const saveRouting = useCallback(
    async (newRouting: OpenRouterProviderRouting) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        await updateOpenRouterProviderRouting(apiKeyId, newRouting);
      } catch (error) {
        // The API-key action reports the failure to the user before rethrowing.
        console.error("Failed to save OpenRouter provider routing", error);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [apiKeyId],
  );

  const handleAddProvider = useCallback(
    (provider: string) => {
      const newOrder = [...providerOrder, provider];
      void saveRouting({
        ...routing,
        order: newOrder,
      });
    },
    [providerOrder, routing, saveRouting],
  );

  const handleRemoveProvider = useCallback(
    (index: number) => {
      const newOrder = providerOrder.filter((_, i) => i !== index);
      void saveRouting({
        ...routing,
        order: newOrder.length > 0 ? newOrder : undefined,
      });
    },
    [providerOrder, routing, saveRouting],
  );

  const handleMoveProvider = useCallback(
    (index: number, direction: "up" | "down") => {
      const newOrder = [...providerOrder];
      const newIndex = direction === "up" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= newOrder.length) {
        return;
      }
      [newOrder[index], newOrder[newIndex]] = [
        newOrder[newIndex],
        newOrder[index],
      ];
      void saveRouting({
        ...routing,
        order: newOrder,
      });
    },
    [providerOrder, routing, saveRouting],
  );

  const handleFallbacksChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      void saveRouting({
        ...routing,
        allow_fallbacks: event.target.checked,
      });
    },
    [routing, saveRouting],
  );

  const handleDataCollectionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      void saveRouting({
        ...routing,
        data_collection: event.target.value as "allow" | "deny",
      });
    },
    [routing, saveRouting],
  );

  return {
    saving,
    handleAddProvider,
    handleRemoveProvider,
    handleMoveProvider,
    handleFallbacksChange,
    handleDataCollectionChange,
  };
};

import { useCallback, useState } from "react";

/** Own the provider fields and a stable updater for add and edit cards. */
export const useApiKeyFormFields = (
  initial: Record<string, string> | (() => Record<string, string>) = {},
) => {
  const [fieldValues, setFieldValues] = useState(initial);
  const handleFieldChange = useCallback((key: string, value: string) => {
    setFieldValues((previous) => ({ ...previous, [key]: value }));
  }, []);
  return { fieldValues, setFieldValues, handleFieldChange };
};

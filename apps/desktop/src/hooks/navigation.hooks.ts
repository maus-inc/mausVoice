import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export const useConsumeQueryParams = (
  paramNames: string[],
  onConsume: (params: (string | null)[]) => void,
) => {
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const params: (string | null)[] = paramNames.map((name) =>
      searchParams.get(name),
    );
    const hasParam = params.some((value) => value !== null);

    if (hasParam) {
      onConsume(params);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          paramNames.forEach((name) => next.delete(name));
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams.toString()]);
};

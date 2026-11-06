import { useEffect, useMemo, useState, type DependencyList } from "react";
import type { Observable, Subscription } from "rxjs";

export type SuccessStreamResult<R> = {
  status: "success";
  data: R;
};

export type ErrorStreamResult = {
  status: "error";
  error: unknown;
};

export type LoadingStreamResult = {
  status: "loading";
};

export type StreamResult<R> =
  SuccessStreamResult<R> | ErrorStreamResult | LoadingStreamResult;

const LOADING: LoadingStreamResult = { status: "loading" };

function useStream<R>(
  builder: () => Promise<Observable<R>> | Observable<R>,
  dependencies: DependencyList,
): StreamResult<R> {
  // Tag every result with the dependency generation that produced it. An old
  // emission can already be queued when React renders the next owner, before
  // the old passive effect has had a chance to unsubscribe.
  const owner = useMemo(() => ({}), dependencies);
  const [result, setResult] = useState<{
    owner: object;
    value: StreamResult<R>;
  }>({ owner, value: LOADING });

  useEffect(() => {
    let subscription: Subscription | null = null;
    let cancelled = false;

    async function setupStream() {
      try {
        const stream$ = await builder();
        if (cancelled) return;
        subscription = stream$.subscribe(
          (data) => {
            if (!cancelled)
              setResult({ owner, value: { status: "success", data } });
          },
          (error) => {
            if (!cancelled)
              setResult({ owner, value: { status: "error", error } });
          },
        );
      } catch (error) {
        if (!cancelled) setResult({ owner, value: { status: "error", error } });
      }
    }

    void setupStream();
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [owner]);

  return result.owner === owner ? result.value : LOADING;
}

export function useStreamWithSideEffects<R>(args: {
  builder: () => Promise<Observable<R>> | Observable<R>;
  dependencies: DependencyList;
  onInit?: () => void;
  onSuccess?: (data: R) => void;
  onError?: (error: unknown) => void;
}): StreamResult<R> {
  const dataStream = useStream(args.builder, args.dependencies);

  useEffect(() => {
    args.onInit?.();
  }, args.dependencies);

  useEffect(() => {
    if (dataStream.status === "success" && args.onSuccess) {
      args.onSuccess(dataStream.data);
    } else if (dataStream.status === "error") {
      if (args.onError) {
        args.onError(dataStream.error);
      } else {
        throw new Error(`Unable to fetch data: ${dataStream.error}`);
      }
    }
  }, [dataStream]);

  return dataStream;
}

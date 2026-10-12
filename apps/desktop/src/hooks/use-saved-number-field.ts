import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logOnRejection } from "../utils/promise.utils";

/**
 * The writes a field has sent and whose arrival has not been seen yet, counted
 * per value rather than listed.
 *
 * A field here commits on blur, and a preference only reaches the store once
 * the repository call returns, so two writes can be in flight at once. Keeping
 * every write in flight — not just the most recent — is what lets the sync
 * effect below tell the field's own writes apart from a preference that changed
 * somewhere else, including an older write landing after a newer one.
 *
 * Counted, not a set, because the same number can be sent twice: 7 to 10 to 20
 * and back to 10 commits 10 once more while the first 10 is still on its way. A
 * set collapses those into one entry, so the first 10 to land spends it, and
 * the second arrives with nothing left to claim it — which reads as a change
 * from somewhere else and writes 10 back over the newer draft. A count keeps
 * each write separate, so every arrival is claimed by exactly one of them.
 *
 * The map holds exactly the writes that have not reported back. Each one leaves
 * either by causing the arrival it is claimed from, or when its save fails,
 * which leaves the store untouched and so means no arrival is coming. That is
 * what bounds it: the entries total the writes in flight, and nothing here can
 * hold a value that is still on its way — which a cap would, turning the
 * arrival of an evicted value into a change from elsewhere and writing it back
 * over a newer draft.
 */
const useOwnWrites = () => {
  const writes = useRef<Map<number, number>>(new Map());
  return useMemo(() => {
    /** One write leaving, whether it arrived or failed to. */
    const drop = (value: number): boolean => {
      const pending = writes.current.get(value);
      if (pending === undefined) {
        return false;
      }
      if (pending > 1) {
        writes.current.set(value, pending - 1);
        return true;
      }
      writes.current.delete(value);
      return true;
    };
    return {
      /** Records a value this field has sent to the store. */
      record: (value: number) => {
        writes.current.set(value, (writes.current.get(value) ?? 0) + 1);
      },
      /**
       * Whether the value that just arrived is one this field wrote. The claim
       * is consumed, so the same value changing again later reads as a change
       * from somewhere else.
       */
      claim: (value: number) => drop(value),
      /** Drops a write whose save failed, because it will never arrive. */
      abandon: (value: number) => {
        drop(value);
      },
    };
  }, []);
};

export type SavedNumberField = {
  /** What the text field shows: the draft, not the stored value. */
  input: string;
  setInput: (value: string) => void;
  /** The message under the field, or null while there is nothing to say. */
  error: string | null;
  /** Saves the draft. Called on blur and on Enter. */
  commit: () => void;
};

type SavedNumberFieldOptions = {
  /** The stored preference, which may move while a write is in flight. */
  saved: number;
  /** How the stored value is shown in the field. */
  format: (value: number) => string;
  /** The draft's value, or null when the field cannot accept it. */
  parse: (input: string) => number | null;
  /** Sends the value to the store. Rejects when the save fails. */
  save: (value: number) => Promise<void>;
  /** What to say about a draft that cannot be saved. */
  invalidMessage: () => string;
  /** Names the write in the log when a save fails. */
  context: string;
};

/**
 * A number field that saves on blur without ever losing the draft.
 *
 * Two things make that harder than a controlled input. The first is that a
 * preference only reaches the store once the save returns, so a slow save lands
 * after the person has already typed the next number — seeding the field from
 * the store on that arrival would write the older value back over their draft,
 * which is the one thing a preferences field must not do. The second is that
 * two saves can be in flight at once, so which arrivals are the field's own is
 * a set and not a slot, and the newest draft has to survive them landing in any
 * order.
 *
 * The skip test answers to the value this field last *asked* to save, not to
 * what is stored: while a save is in flight the store still holds the old
 * preference, so someone who changes 7 to 10 and then back to 7 before the
 * first save lands is asking for 7, and comparing against the store would
 * refuse that reversion. A request whose save failed is forgotten, because a
 * failed save leaves the preference alone and the same number must be
 * committable again.
 */
export const useSavedNumberField = ({
  saved,
  format,
  parse,
  save,
  invalidMessage,
  context,
}: SavedNumberFieldOptions): SavedNumberField => {
  const [input, setInput] = useState(() => format(saved));
  const [error, setError] = useState<string | null>(null);
  const requested = useRef<number | null>(saved);
  const writes = useOwnWrites();

  // The seeding effect below is about the stored value changing, and nothing
  // else. Reading the formatter through a ref keeps it that way: callers pass
  // it inline as often as not, and an inlined `format` is a new function on
  // every render, which would make the effect run on every render and write the
  // stored value back over the draft after each keystroke — the failure this
  // hook exists to prevent, arriving by another road. Declared first so it is
  // current before the effect below reads it.
  const formatRef = useRef(format);
  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  // Seeding the field is only right for a value from somewhere else. The value
  // this field sent arrives here too, and by then it may be older than what is
  // on screen.
  useEffect(() => {
    if (!writes.claim(saved)) {
      // A value that came from somewhere else is also the baseline a later
      // commit has to differ from. Without this the baseline stays at whatever
      // the store held when the field mounted, and someone who types that older
      // number back in is told there is nothing to save while the store still
      // holds the newer one.
      requested.current = saved;
      setInput(formatRef.current(saved));
      setError(null);
    }
  }, [saved, writes]);

  const commit = useCallback(() => {
    const value = parse(input);
    if (value === null) {
      setError(invalidMessage());
      return;
    }

    setError(null);
    // The draft is replaced by the canonical rendering of what will be saved,
    // so "5" and "05" cannot both sit in the field.
    setInput(format(value));
    if (value === requested.current) {
      return;
    }

    writes.record(value);
    requested.current = value;
    logOnRejection(
      // `error_` because the field's own message state is `error`: same
      // convention as the rest of the app where a caught error has to live
      // beside one.
      save(value).catch((error_: unknown) => {
        // A failed save shows its own snackbar and leaves the preference alone,
        // so the same number has to be committable again. Only this write's
        // request is forgotten — a newer one may have replaced it while this
        // was in flight.
        if (requested.current === value) {
          requested.current = null;
        }
        writes.abandon(value);
        throw error_;
      }),
      context,
    );
  }, [input, parse, invalidMessage, format, save, context, writes]);

  return useMemo(
    () => ({ input, setInput, error, commit }),
    [input, error, commit],
  );
};

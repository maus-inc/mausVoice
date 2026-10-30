import { Term } from "@maus-inc/types";
import { invoke } from "@tauri-apps/api/core";
import dayjs from "dayjs";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

type LocalTerm = {
  id: string;
  createdAt: number;
  createdByUserId: string;
  sourceValue: string;
  destinationValue: string;
  isReplacement: boolean;
  isDeleted: boolean;
};

const toLocalTerm = (term: Term): LocalTerm => ({
  id: term.id,
  createdAt: dayjs(term.createdAt).valueOf(),
  createdByUserId: "",
  sourceValue: term.sourceValue,
  destinationValue: term.destinationValue,
  isReplacement: term.isReplacement,
  isDeleted: false,
});

const fromLocalTerm = (term: LocalTerm): Term => ({
  id: term.id,
  createdAt: dayjs(term.createdAt).toISOString(),
  sourceValue: term.sourceValue,
  destinationValue: term.destinationValue,
  isReplacement: term.isReplacement,
});

export abstract class BaseTermRepo extends BaseRepo {
  abstract listTerms(): Promise<Term[]>;
  abstract createTerm(term: Term, lease?: LocalDataWriteLease): Promise<Term>;
  abstract updateTerm(term: Term, lease?: LocalDataWriteLease): Promise<Term>;
  abstract deleteTerm(
    termId: string,
    lease?: LocalDataWriteLease,
  ): Promise<void>;
}

export class LocalTermRepo extends BaseTermRepo {
  async listTerms(): Promise<Term[]> {
    const terms = await invoke<LocalTerm[]>("term_list");
    return terms.map(fromLocalTerm);
  }

  createTerm(term: Term, lease?: LocalDataWriteLease): Promise<Term> {
    return withLocalDataWrite(async () => {
      const created = await invoke<LocalTerm>("term_create", {
        term: toLocalTerm(term),
      });
      return fromLocalTerm(created);
    }, lease);
  }

  updateTerm(term: Term, lease?: LocalDataWriteLease): Promise<Term> {
    return withLocalDataWrite(async () => {
      const updated = await invoke<LocalTerm>("term_update", {
        term: toLocalTerm(term),
      });
      return fromLocalTerm(updated);
    }, lease);
  }

  deleteTerm(termId: string, lease?: LocalDataWriteLease): Promise<void> {
    return withLocalDataWrite(
      () => invoke<void>("term_delete", { id: termId }),
      lease,
    );
  }
}

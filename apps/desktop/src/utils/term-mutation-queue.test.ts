import type { Term } from "@maus-inc/types";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../repos", () => ({
  getTermRepo: () => ({
    createTerm: mocks.create,
    updateTerm: mocks.update,
    deleteTerm: mocks.remove,
  }),
}));
import {
  createDictionaryTerm,
  deleteDictionaryTerm,
  updateDictionaryTerm,
} from "./term-mutation-queue";
const term = {
  id: "new",
  sourceValue: "first",
  destinationValue: "",
  isReplacement: false,
} as Term;
const deferred = () => {
  let resolve!: (term: Term) => void, reject!: (error: Error) => void;
  const promise = new Promise<Term>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.remove.mockReset();
});
it("orders edits and deletion after creation for the same term", async () => {
  const waiting = deferred();
  const edited = { ...term, sourceValue: "second" };
  const order: string[] = [];
  mocks.create.mockImplementation(() => {
    order.push("create");
    return waiting.promise;
  });
  mocks.update.mockImplementation(async () => {
    order.push("update");
    return edited;
  });
  mocks.remove.mockImplementation(async () => {
    order.push("delete");
  });
  const add = createDictionaryTerm(
    term,
    () => {},
    () => {},
  );
  const update = updateDictionaryTerm(term, edited, () => {});
  const remove = deleteDictionaryTerm(edited, () => {});
  await vi.waitFor(() => expect(order).toEqual(["create"]));
  waiting.resolve(term);
  await Promise.all([add, update, remove]);
  expect(order).toEqual(["create", "update", "delete"]);
});
it("does not update, delete, or restore an entry whose creation failed", async () => {
  const waiting = deferred();
  const failure = vi.fn(),
    deleteFailure = vi.fn(),
    updateFailure = vi.fn();
  mocks.create.mockReturnValue(waiting.promise);
  const add = createDictionaryTerm(term, () => {}, failure);
  const update = updateDictionaryTerm(
    term,
    { ...term, sourceValue: "edit" },
    updateFailure,
  );
  const remove = deleteDictionaryTerm(term, deleteFailure);
  waiting.reject(new Error("creation failed"));
  await Promise.all([add, update, remove]);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(updateFailure).not.toHaveBeenCalled();
  expect(deleteFailure).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

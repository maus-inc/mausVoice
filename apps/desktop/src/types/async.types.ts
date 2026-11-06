export type AsyncData<T> = (
  | {
      state: "loading";
    }
  | {
      state: "error";
      error: string;
    }
  | {
      state: "success";
      data: T;
    }
) & {
  refresh: () => Promise<void>;
};

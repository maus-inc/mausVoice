import { invoke } from "@tauri-apps/api/core";

import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { BaseRepo, withLocalDataWrite } from "./base.repo";

export type StorageUploadData = Uint8Array | ArrayBuffer | number[];

export type StorageUploadInput = {
  path: string;
  data: StorageUploadData;
};

const normalizeData = (data: StorageUploadData): number[] => {
  if (data instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(data));
  }
  if (data instanceof Uint8Array) {
    return Array.from(data);
  }

  return data;
};

export abstract class BaseStorageRepo extends BaseRepo {
  abstract uploadData(
    args: StorageUploadInput,
    lease?: LocalDataWriteLease,
  ): Promise<void>;
  abstract getDownloadUrl(
    path: string,
    lease?: LocalDataWriteLease,
  ): Promise<string>;
}

export class LocalStorageRepo extends BaseStorageRepo {
  uploadData(
    { path, data }: StorageUploadInput,
    lease?: LocalDataWriteLease,
  ): Promise<void> {
    return withLocalDataWrite(
      () =>
        invoke<void>("storage_upload_data", {
          args: {
            path,
            data: normalizeData(data),
          },
        }),
      lease,
    );
  }

  getDownloadUrl(path: string, lease?: LocalDataWriteLease): Promise<string> {
    return withLocalDataWrite(
      () => invoke<string>("storage_get_download_url", { path }),
      lease,
    );
  }
}

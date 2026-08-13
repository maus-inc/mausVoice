import { GpuInfo } from "./gpu.types";

/**
 * Mirrors the Rust `SystemCapabilities` struct returned by
 * `get_system_capabilities` (specta bindings will regenerate it).
 */
export type SystemCapabilities = {
  ramGb: number;
  cpuCores: number;
  gpus: GpuInfo[];
};

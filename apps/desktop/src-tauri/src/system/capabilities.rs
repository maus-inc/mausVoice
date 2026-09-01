use serde::{Deserialize, Serialize};

/// Static machine capabilities used to recommend (or discourage) local
/// transcription models: total RAM, CPU core count, and the existing GPU
/// enumeration.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapabilities {
    pub ram_gb: f64,
    pub cpu_cores: u32,
    pub gpus: Vec<crate::system::gpu::GpuAdapterInfo>,
}

/// Collects RAM via `sysinfo` (built with only the `system` feature, so only
/// the core `System::new` + `refresh_memory` API is available) and the CPU
/// core count via the standard library, then reuses the GPU enumeration.
/// Values are best-effort: on any platform quirk the struct degrades to
/// zeros rather than failing the caller.
pub fn get_system_capabilities() -> SystemCapabilities {
    let mut system = sysinfo::System::new();
    system.refresh_memory();

    let total_ram_bytes = system.total_memory();
    let ram_gb = (total_ram_bytes as f64) / (1024.0 * 1024.0 * 1024.0);
    let cpu_cores = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(0);

    SystemCapabilities {
        ram_gb: (ram_gb * 10.0).round() / 10.0,
        cpu_cores,
        gpus: crate::system::gpu::list_available_gpus(),
    }
}

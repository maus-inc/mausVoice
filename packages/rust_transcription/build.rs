use std::env;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tar::Archive;

const ORT_VERSION: &str = "1.23.2";
const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

struct RuntimeAsset {
    archive_name: &'static str,
    sha256: &'static str,
    archive_kind: ArchiveKind,
}

#[derive(Clone, Copy)]
enum ArchiveKind {
    TarGz,
    Zip,
}

fn main() {
    println!("cargo:rerun-if-env-changed=MAUSVOICE_ORT_DYLIB_PATH");
    println!("cargo:rerun-if-env-changed=ORT_DYLIB_PATH");
    println!("cargo:rerun-if-changed=build.rs");

    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let library_name = runtime_library_name(&target);
    let runtime_path = configured_runtime()
        .unwrap_or_else(|| provision_runtime(&target, library_name));

    // Keep a copy beside normal binaries and test executables. This makes the
    // standalone sidecar useful outside the Tauri bundle and gives Cargo tests
    // a relocatable fallback in addition to the compile-time cache path.
    if let Some(profile_dir) = profile_directory() {
        copy_if_changed(&runtime_path, &profile_dir.join(library_name));
        copy_if_changed(&runtime_path, &profile_dir.join("deps").join(library_name));
    }

    println!(
        "cargo:rustc-env=MAUSVOICE_BUILD_ORT_DYLIB={}",
        runtime_path.display()
    );
}

fn configured_runtime() -> Option<PathBuf> {
    ["MAUSVOICE_ORT_DYLIB_PATH", "ORT_DYLIB_PATH"]
        .into_iter()
        .filter_map(|name| env::var_os(name).map(PathBuf::from))
        .find(|path| path.is_file())
}

fn provision_runtime(target: &str, library_name: &str) -> PathBuf {
    let asset = runtime_asset(target).unwrap_or_else(|| {
        panic!(
            "no bundled ONNX Runtime is defined for target '{target}'; set MAUSVOICE_ORT_DYLIB_PATH to a compatible ONNX Runtime {ORT_VERSION} library"
        )
    });
    let archive_stem = asset
        .archive_name
        .strip_suffix(".tgz")
        .or_else(|| asset.archive_name.strip_suffix(".zip"))
        .unwrap_or(asset.archive_name);
    let cache_dir = cargo_target_directory()
        .join("mausvoice-onnxruntime")
        .join(ORT_VERSION)
        .join(archive_stem);
    fs::create_dir_all(&cache_dir).unwrap_or_else(|error| {
        panic!(
            "failed to create ONNX Runtime cache '{}': {error}",
            cache_dir.display()
        )
    });

    let runtime_path = cache_dir.join(library_name);
    if runtime_path.is_file() {
        return runtime_path;
    }

    let archive_path = cache_dir.join(asset.archive_name);
    if archive_path.is_file() {
        if !verify_file_digest(&archive_path, asset.sha256) {
            let _ = fs::remove_file(&archive_path);
            download_verified(&asset, &archive_path);
        }
    } else {
        download_verified(&asset, &archive_path);
    }
    extract_runtime(&archive_path, asset.archive_kind, target, &runtime_path);
    runtime_path
}

fn verify_file_digest(path: &Path, expected_sha256: &str) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => hasher.update(&buffer[..count]),
            Err(_) => return false,
        }
    }
    let actual = format!("{:x}", hasher.finalize());
    actual.eq_ignore_ascii_case(expected_sha256)
}

fn download_verified(asset: &RuntimeAsset, archive_path: &Path) {
    let url = format!(
        "https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{}",
        asset.archive_name
    );
    let temporary_path = archive_path.with_extension(format!(
        "{}.{}.part",
        archive_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("archive"),
        std::process::id()
    ));

    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .build(),
    );
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let result = (|| -> Result<(), String> {
            let mut response = agent
                .get(&url)
                .call()
                .map_err(|error| format!("request failed: {error}"))?;
            let mut reader = response
                .body_mut()
                .with_config()
                .limit(MAX_DOWNLOAD_BYTES)
                .reader();
            let mut output = File::create(&temporary_path)
                .map_err(|error| format!("failed to create download: {error}"))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];

            loop {
                let count = reader
                    .read(&mut buffer)
                    .map_err(|error| format!("failed while downloading: {error}"))?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|error| format!("failed to write download: {error}"))?;
                hasher.update(&buffer[..count]);
            }
            output
                .sync_all()
                .map_err(|error| format!("failed to flush download: {error}"))?;

            let actual = format!("{:x}", hasher.finalize());
            if actual != asset.sha256 {
                return Err(format!(
                    "SHA-256 mismatch (expected {}, got {actual})",
                    asset.sha256
                ));
            }
            Ok(())
        })();

        match result {
            Ok(()) => {
                fs::rename(&temporary_path, archive_path).unwrap_or_else(|error| {
                    panic!(
                        "failed to store verified ONNX Runtime archive '{}': {error}",
                        archive_path.display()
                    )
                });
                return;
            }
            Err(error) => {
                last_error = error;
                let _ = fs::remove_file(&temporary_path);
                if attempt < 3 {
                    thread::sleep(Duration::from_secs(attempt * 2));
                }
            }
        }
    }

    panic!(
        "failed to download verified ONNX Runtime archive from '{url}' after 3 attempts: {last_error}"
    );
}

fn extract_runtime(
    archive_path: &Path,
    archive_kind: ArchiveKind,
    target: &str,
    destination: &Path,
) {
    let temporary_path = destination.with_extension(format!(
        "{}.{}.part",
        destination
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("library"),
        std::process::id()
    ));
    let result = match archive_kind {
        ArchiveKind::TarGz => extract_from_tar_gz(archive_path, target, &temporary_path),
        ArchiveKind::Zip => extract_from_zip(archive_path, target, &temporary_path),
    };
    result.unwrap_or_else(|error| {
        let _ = fs::remove_file(&temporary_path);
        panic!(
            "failed to extract ONNX Runtime library from '{}': {error}",
            archive_path.display()
        )
    });
    fs::rename(&temporary_path, destination).unwrap_or_else(|error| {
        panic!(
            "failed to store ONNX Runtime library '{}': {error}",
            destination.display()
        )
    });
}

fn extract_from_tar_gz(archive_path: &Path, target: &str, destination: &Path) -> io::Result<()> {
    let file = File::open(archive_path)?;
    let mut archive = Archive::new(GzDecoder::new(file));
    for entry in archive.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?;
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if is_runtime_library(name, target) {
            let mut output = File::create(destination)?;
            io::copy(&mut entry, &mut output)?;
            output.sync_all()?;
            return Ok(());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "archive contains no ONNX Runtime dynamic library",
    ))
}

fn extract_from_zip(archive_path: &Path, target: &str, destination: &Path) -> io::Result<()> {
    let file = File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(io::Error::other)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io::Error::other)?;
        let Some(name) = Path::new(entry.name())
            .file_name()
            .and_then(|name| name.to_str())
        else {
            continue;
        };
        if is_runtime_library(name, target) {
            let mut output = File::create(destination)?;
            io::copy(&mut entry, &mut output)?;
            output.sync_all()?;
            return Ok(());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "archive contains no ONNX Runtime dynamic library",
    ))
}

fn is_runtime_library(name: &str, target: &str) -> bool {
    if target.contains("windows") {
        name.eq_ignore_ascii_case("onnxruntime.dll")
    } else if target.contains("apple-darwin") {
        name.starts_with("libonnxruntime")
            && !name.starts_with("libonnxruntime_providers")
            && name.ends_with(".dylib")
    } else {
        name.starts_with("libonnxruntime.so")
    }
}

fn runtime_library_name(target: &str) -> &'static str {
    if target.contains("windows") {
        "onnxruntime.dll"
    } else if target.contains("apple-darwin") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

fn runtime_asset(target: &str) -> Option<RuntimeAsset> {
    let (archive_name, sha256, archive_kind) = match target {
        "x86_64-unknown-linux-gnu" => (
            "onnxruntime-linux-x64-1.23.2.tgz",
            "1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b",
            ArchiveKind::TarGz,
        ),
        "aarch64-unknown-linux-gnu" => (
            "onnxruntime-linux-aarch64-1.23.2.tgz",
            "7c63c73560ed76b1fac6cff8204ffe34fe180e70d6582b5332ec094810241e5c",
            ArchiveKind::TarGz,
        ),
        "x86_64-apple-darwin" | "aarch64-apple-darwin" => (
            "onnxruntime-osx-universal2-1.23.2.tgz",
            "49ae8e3a66ccb18d98ad3fe7f5906b6d7887df8a5edd40f49eb2b14e20885809",
            ArchiveKind::TarGz,
        ),
        "x86_64-pc-windows-msvc" => (
            "onnxruntime-win-x64-1.23.2.zip",
            "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd",
            ArchiveKind::Zip,
        ),
        "aarch64-pc-windows-msvc" => (
            "onnxruntime-win-arm64-1.23.2.zip",
            "1cfe88b6435df3b5fb0e9f6bd7d6f5df1e887b6174de7f6e2a47bab956f3f168",
            ArchiveKind::Zip,
        ),
        _ => return None,
    };
    Some(RuntimeAsset {
        archive_name,
        sha256,
        archive_kind,
    })
}

fn profile_directory() -> Option<PathBuf> {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR")?);
    out_dir.ancestors().nth(3).map(Path::to_path_buf)
}

fn cargo_target_directory() -> PathBuf {
    if let Some(path) = env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) {
        return if path.is_absolute() {
            path
        } else {
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join(path)
        };
    }

    let profile_dir = profile_directory().expect("Cargo did not provide a recognizable OUT_DIR");
    let target = env::var("TARGET").expect("Cargo did not provide TARGET");
    let parent = profile_dir
        .parent()
        .expect("Cargo profile directory has no parent");
    if parent.file_name().and_then(|name| name.to_str()) == Some(target.as_str()) {
        parent
            .parent()
            .expect("Cargo target-specific directory has no parent")
            .to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

fn copy_if_changed(source: &Path, destination: &Path) {
    if let (Ok(source_metadata), Ok(destination_metadata)) =
        (fs::metadata(source), fs::metadata(destination))
    {
        if destination_metadata.is_file()
            && source_metadata.len() == destination_metadata.len()
            && matches!(
                (source_metadata.modified(), destination_metadata.modified()),
                (Ok(source_modified), Ok(destination_modified))
                    if destination_modified >= source_modified
            )
        {
            return;
        }
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|error| {
            panic!(
                "failed to create ONNX Runtime output directory '{}': {error}",
                parent.display()
            )
        });
    }
    fs::copy(source, destination).unwrap_or_else(|error| {
        panic!(
            "failed to copy ONNX Runtime library from '{}' to '{}': {error}",
            source.display(),
            destination.display()
        )
    });
}

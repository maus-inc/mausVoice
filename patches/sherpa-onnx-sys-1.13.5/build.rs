use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::{collections::HashSet, ffi::OsString};

use bzip2::read::BzDecoder;
use sha2::{Digest, Sha256};
use tar::Archive;

const RELEASE_BASE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/// Pinned cryptographic SHA-256 digests for official v1.13.5 platform release archives.
/// Any downloaded or locally copied archive must match its pinned digest before extraction.
const ARCHIVE_SHA256_DIGESTS: &[(&str, &str)] = &[
    (
        "sherpa-onnx-v1.13.5-linux-x64-static-lib.tar.bz2",
        "2ade8b7c62de66b9cf2e32bd7dbe077addaa4b18f422b49dc1bf3a1a0b1f762e",
    ),
    (
        "sherpa-onnx-v1.13.5-linux-aarch64-static-lib.tar.bz2",
        "f78af8260892f3060c8c0aba9ae93e4e4c1b16fe509238b88e3688889235e1b2",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-x64-static-lib.tar.bz2",
        "689f8167a52dc4dbaf05369705e26c8f203c748a8c342750fdfdcd8ca6bb8699",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-arm64-static-lib.tar.bz2",
        "339c8fc19bb4b26e118c80792bbc4546eb263040fac36ef0cc027ec29c756b44",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-universal2-static-lib.tar.bz2",
        "9e64f3274c4209c485fdb936c22bee27f4940e1872f3e93abe0e3e6db0190148",
    ),
    (
        "sherpa-onnx-v1.13.5-win-x64-static-MT-Release-lib.tar.bz2",
        "b7080b6f470bac96ef0afe56b25ae9b2f9f0ca82d10dad19bf3a2fc5ffd6cffc",
    ),
    (
        "sherpa-onnx-v1.13.5-linux-x64-shared-lib.tar.bz2",
        "dee76d27657cab8cb95a47322e88d93977d9a7e75f0a1abad032d8843e1542c9",
    ),
    (
        "sherpa-onnx-v1.13.5-linux-aarch64-shared-cpu-lib.tar.bz2",
        "e9e284e887c67959f45b2cad834d9b2fae281bb4e8e596928ffe371506d803ac",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-x64-shared-lib.tar.bz2",
        "e1868ca5b756b0d5d33682b187cbce6cd448edf785e3fa8b7586f2c04cb0d84c",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-arm64-shared-lib.tar.bz2",
        "df54b4f9406e00c3aee9152aeca65795848d197b80917ecb0bd472b852c5db9f",
    ),
    (
        "sherpa-onnx-v1.13.5-osx-universal2-shared-lib.tar.bz2",
        "79b1635418e1ec0ec2f72f7a2bda1467914cbb9a9e411b5b4800d97fc1110598",
    ),
    (
        "sherpa-onnx-v1.13.5-win-x64-shared-MT-Release-lib.tar.bz2",
        "e7092add4a05013043b5c7f0fa4ccd3de9cf2840a51b6501caf20c03086d2b97",
    ),
    (
        "sherpa-onnx-v1.13.5-android.tar.bz2",
        "635eee004bf12d5881789876ea01964a6ef10dc74ccf317271ba9388d8718a84",
    ),
];
const SHERPA_ONNX_STATIC_LIBS: &[&str] = &[
    "sherpa-onnx-c-api",
    "sherpa-onnx-core",
    "kaldi-decoder-core",
    "sherpa-onnx-kaldifst-core",
    "sherpa-onnx-fstfar",
    "sherpa-onnx-fst",
    "kaldi-native-fbank-core",
    "kissfft-float",
    "piper_phonemize",
    "espeak-ng",
    "ucd",
    "onnxruntime",
    "ssentencepiece_core",
];

type DynError = Box<dyn Error>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LinkMode {
    Static,
    Shared,
}

fn main() {
    if let Err(err) = try_main() {
        panic!("{err}");
    }
}

fn try_main() -> Result<(), DynError> {
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_LIB_DIR");
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_ARCHIVE_DIR");
    println!("cargo:rerun-if-env-changed=DOCS_RS");

    if env::var_os("DOCS_RS").is_some() {
        // docs.rs sets DOCS_RS=1; skip downloading/linking native libraries
        // so that `cargo doc` can succeed without the real C artifacts.
        return Ok(());
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS")?;
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH")?;
    let link_mode = resolve_link_mode()?;
    let lib_dir = resolve_lib_dir(link_mode, &target_os, &target_arch)?;

    println!("cargo:rustc-link-search=native={}", lib_dir.display());

    if link_mode == LinkMode::Shared
        && matches!(target_os.as_str(), "linux" | "macos" | "android")
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
        emit_relative_rpath(&target_os);
        copy_unix_runtime_libs(&lib_dir, &target_os)?;
    }

    if link_mode == LinkMode::Shared && target_os == "windows" {
        copy_windows_runtime_dlls(&lib_dir)?;
    }

    match link_mode {
        LinkMode::Static => emit_static_link_directives(&target_os),
        LinkMode::Shared => emit_shared_link_directives(),
    }

    Ok(())
}

fn resolve_link_mode() -> Result<LinkMode, DynError> {
    let static_enabled = env::var_os("CARGO_FEATURE_STATIC").is_some();
    let shared_enabled = env::var_os("CARGO_FEATURE_SHARED").is_some();

    if static_enabled && shared_enabled {
        return Err("Features `static` and `shared` cannot be enabled at the same time".into());
    }

    if shared_enabled {
        Ok(LinkMode::Shared)
    } else {
        Ok(LinkMode::Static)
    }
}

fn resolve_lib_dir(
    link_mode: LinkMode,
    target_os: &str,
    target_arch: &str,
) -> Result<PathBuf, DynError> {
    if let Some(path) = env::var_os("SHERPA_ONNX_LIB_DIR") {
        let path = PathBuf::from(path);
        if !path.is_dir() {
            return Err(format!(
                "SHERPA_ONNX_LIB_DIR does not exist or is not a directory: {}",
                path.display()
            )
            .into());
        }
        return Ok(path);
    }

    download_prebuilt_libs(link_mode, target_os, target_arch)
}

fn download_prebuilt_libs(
    link_mode: LinkMode,
    target_os: &str,
    target_arch: &str,
) -> Result<PathBuf, DynError> {
    let archive_name = archive_name(link_mode, target_os, target_arch)?;
    let archive_stem = archive_name.trim_end_matches(".tar.bz2");

    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let cache_root = target_dir_from_out_dir(&out_dir)?.join("sherpa-onnx-prebuilt");
    let extracted_dir = cache_root.join(archive_stem);
    let lib_dir = extracted_dir.join("lib");

    let archive_path = cache_root.join(&archive_name);
    // Android archives use jniLibs/{abi}/ instead of lib/. Check both.
    let android_lib_dir = extracted_dir.join("jniLibs").join(android_abi(target_arch));
    let cached_dir = if lib_dir.is_dir() {
        Some(&lib_dir)
    } else if android_lib_dir.is_dir() {
        Some(&android_lib_dir)
    } else {
        None
    };

    // Verifying the archive is necessary but not sufficient, and that gap is what
    // this closes: the pinned digest covers the archive, while the linker reads
    // the *extracted* `.so`/`.a` files. A local process that rewrites a file under
    // `extracted_dir` after extraction leaves the archive byte-identical, so the
    // pinned digest still passes and the modified content gets linked. The
    // extracted tree therefore carries a digest of its own, recorded beside it,
    // and the cache is reused only while that still matches.
    let tree_digest_path = cache_root.join(format!("{archive_stem}.extracted.sha256"));
    if let Some(dir) = cached_dir {
        if archive_path.is_file() {
            // A mismatch is a hard failure, not something to re-download over:
            // `verify_archive_digest` has already deleted the archive, and a
            // tampered archive is exactly the case that must not be papered over.
            verify_archive_digest(&archive_path, &archive_name)?;
            if verify_extracted_tree(&extracted_dir, &tree_digest_path)? {
                eprintln!(
                    "Using verified cached sherpa-onnx libs at {}",
                    dir.display()
                );
                return Ok(dir.clone());
            }
            // The archive just matched its pinned digest, so unpacking it again
            // reproduces the official tree exactly. Falling through to the
            // extraction below repairs the cache without re-downloading anything,
            // and that is what keeps the first run after this change from being a
            // permanent failure: no digest is recorded yet at that point, so every
            // existing cache is unverifiable and re-extracting is the repair.
            // Failing here instead would break that run for good.
            eprintln!(
                "Re-extracting sherpa-onnx libs at {}: the extracted tree does not match its recorded digest, so it cannot be linked as it stands",
                extracted_dir.display()
            );
        }
        // The archive is gone but the extracted tree is still here, so nothing
        // about that tree can be traced to a pinned digest. Drop it and fetch
        // the archive again rather than link against an unverifiable directory.
        eprintln!(
            "Discarding unverifiable cached sherpa-onnx libs at {}: the archive it came from is missing",
            extracted_dir.display()
        );
        let _ = fs::remove_dir_all(&extracted_dir);
        // Drop the recorded digest along with the tree. Left behind it would
        // describe a directory that no longer exists, so a later extraction that
        // differed would be re-extracted forever.
        let _ = fs::remove_file(&tree_digest_path);
    }

    fs::create_dir_all(&cache_root)?;

    if !archive_path.is_file() {
        if let Some(local_archive_dir) = env::var_os("SHERPA_ONNX_ARCHIVE_DIR") {
            let local_archive_path = PathBuf::from(local_archive_dir).join(&archive_name);
            if !local_archive_path.is_file() {
                return Err(format!(
                    "SHERPA_ONNX_ARCHIVE_DIR does not contain expected archive: {}",
                    local_archive_path.display()
                )
                .into());
            }

            copy_file_atomically(&local_archive_path, &archive_path)?;
        } else {
            let version = env!("CARGO_PKG_VERSION");
            let url = format!("{RELEASE_BASE_URL}/v{version}/{archive_name}");
            eprintln!("Downloading sherpa-onnx libs from {url}");

            let response = ureq::builder()
                .try_proxy_from_env(true)
                .build()
                .get(&url)
                .call()
                .map_err(|e| format!("Failed to download sherpa-onnx archive from {url}: {e}"))?;
            let mut reader = response.into_reader();
            write_reader_atomically(&mut reader, &archive_path)?;
        }
    }

    if extracted_dir.exists() {
        fs::remove_dir_all(&extracted_dir)?;
    }
    // Cleared before the unpack as well as the tree: a digest describing the old
    // tree must not survive into the window where the new one is being written, or
    // an interrupted unpack would leave behind a digest matching nothing.
    let _ = fs::remove_file(&tree_digest_path);

    // Verify cryptographic SHA-256 digest before unpacking
    verify_archive_digest(&archive_path, &archive_name)?;

    let unpack_result: Result<(), DynError> = (|| {
        let tar_file = File::open(&archive_path)?;
        let decoder = BzDecoder::new(tar_file);
        let mut archive = Archive::new(decoder);
        archive.unpack(&cache_root)?;
        Ok(())
    })();
    if let Err(err) = unpack_result {
        let _ = fs::remove_file(&archive_path);
        let _ = fs::remove_dir_all(&extracted_dir);
        // No digest is recorded for a tree that did not unpack cleanly, so a partial
        // extraction can never be mistaken for a verified one afterwards.
        let _ = fs::remove_file(&tree_digest_path);
        return Err(format!(
            "Failed to unpack cached archive {}: {err}",
            archive_path.display()
        )
        .into());
    }

    // Record what was just extracted, so the next build can tell this tree from one
    // that has been altered since. Written only after a successful unpack of an
    // archive that matched its pinned digest, which is what makes the recorded
    // digest a statement about official content rather than about whatever
    // happened to be on disk.
    record_extracted_tree_digest(&extracted_dir, &tree_digest_path)?;

    if !lib_dir.is_dir() {
        // Android archives use jniLibs/{abi}/ instead of lib/.
        let android_lib_dir = extracted_dir
            .join("jniLibs")
            .join(android_abi(target_arch));
        if android_lib_dir.is_dir() {
            eprintln!("Downloaded sherpa-onnx Android libs to {}", android_lib_dir.display());
            return Ok(android_lib_dir);
        }
        return Err(format!(
            "Downloaded archive did not contain a lib directory: {}",
            lib_dir.display()
        )
        .into());
    }

    eprintln!("Downloaded sherpa-onnx libs to {}", extracted_dir.display());

    Ok(lib_dir)
}

/// Map a Rust target architecture to the Android ABI directory name used
/// in the prebuilt jniLibs/ layout.
fn android_abi(target_arch: &str) -> &str {
    match target_arch {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86" => "x86",
        "x86_64" => "x86_64",
        _ => "arm64-v8a",
    }
}

fn archive_name(
    link_mode: LinkMode,
    target_os: &str,
    target_arch: &str,
) -> Result<String, DynError> {
    let version = env!("CARGO_PKG_VERSION");
    let name = match (link_mode, target_os, target_arch) {
        (LinkMode::Static, "linux", "x86_64") => {
            format!("sherpa-onnx-v{version}-linux-x64-static-lib.tar.bz2")
        }
        (LinkMode::Static, "linux", "aarch64") => {
            format!("sherpa-onnx-v{version}-linux-aarch64-static-lib.tar.bz2")
        }
        (LinkMode::Static, "macos", "x86_64") => {
            format!("sherpa-onnx-v{version}-osx-x64-static-lib.tar.bz2")
        }
        (LinkMode::Static, "macos", "aarch64") => {
            format!("sherpa-onnx-v{version}-osx-arm64-static-lib.tar.bz2")
        }
        (LinkMode::Static, "windows", "x86_64") => {
            format!("sherpa-onnx-v{version}-win-x64-static-MT-Release-lib.tar.bz2")
        }
        (LinkMode::Shared, "linux", "x86_64") => {
            format!("sherpa-onnx-v{version}-linux-x64-shared-lib.tar.bz2")
        }
        (LinkMode::Shared, "linux", "aarch64") => {
            format!("sherpa-onnx-v{version}-linux-aarch64-shared-cpu-lib.tar.bz2")
        }
        (LinkMode::Shared, "macos", "x86_64") => {
            format!("sherpa-onnx-v{version}-osx-x64-shared-lib.tar.bz2")
        }
        (LinkMode::Shared, "macos", "aarch64") => {
            format!("sherpa-onnx-v{version}-osx-arm64-shared-lib.tar.bz2")
        }
        (LinkMode::Shared, "windows", "x86_64") => {
            format!("sherpa-onnx-v{version}-win-x64-shared-MT-Release-lib.tar.bz2")
        }
        // Android: one archive with all ABIs under jniLibs/{abi}/.
        (LinkMode::Shared, "android", "aarch64" | "arm" | "x86" | "x86_64") => {
            format!("sherpa-onnx-v{version}-android.tar.bz2")
        }
        // The Android archive holds shared objects only, under jniLibs/{abi}/.
        // There is no static Android release to resolve against, so a static
        // request is refused here rather than answered with a directory of
        // `.so` files: `emit_static_link_directives` would go on to ask the
        // linker for twelve `static=` archives that are not there, and the
        // failure would read as a missing library rather than as a request this
        // build cannot serve.
        (LinkMode::Static, "android", _) => {
            return Err(format!(
                "sherpa-onnx prebuilt libs for target_os=\"android\" ship shared objects \
                 only (jniLibs/{{abi}}), so the `static` feature cannot be linked there. \
                 Request `shared` for the android target instead of `static`."
            )
            .into())
        }
        _ => return Err(format!(
            "Unsupported target for sherpa-onnx prebuilt libs: os={target_os}, arch={target_arch}"
        )
        .into()),
    };

    Ok(name)
}

fn emit_shared_link_directives() {
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    println!("cargo:rustc-link-lib=dylib=onnxruntime");
}

fn emit_static_link_directives(target_os: &str) {
    for lib in SHERPA_ONNX_STATIC_LIBS {
        println!("cargo:rustc-link-lib=static={lib}");
    }

    match target_os {
        "linux" => {
            println!("cargo:rustc-link-lib=dylib=stdc++");
            println!("cargo:rustc-link-lib=dylib=m");
            println!("cargo:rustc-link-lib=dylib=pthread");
            println!("cargo:rustc-link-lib=dylib=dl");
        }
        "macos" => {
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=Foundation");
        }
        _ => {}
    }
}

fn target_dir_from_out_dir(out_dir: &Path) -> Result<PathBuf, DynError> {
    if let Ok(explicit_target_dir) = env::var("CARGO_TARGET_DIR") {
        return Ok(PathBuf::from(explicit_target_dir));
    }

    if let Some(target_dir) = out_dir
        .ancestors()
        .find(|path| path.file_name() == Some(OsStr::new("target")))
    {
        return Ok(target_dir.to_path_buf());
    }

    Ok(out_dir.to_path_buf())
}

fn emit_relative_rpath(target_os: &str) {
    match target_os {
        "linux" | "android" => println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN"),
        "macos" => println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path"),
        _ => {}
    }
}

fn profile_output_dirs() -> Result<[PathBuf; 2], DynError> {
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let profile = env::var("PROFILE")?;
    let profile_dir = out_dir
        .ancestors()
        .find(|path| path.file_name() == Some(OsStr::new(&profile)))
        .ok_or_else(|| {
            format!(
                "Could not locate Cargo profile directory from {}",
                out_dir.display()
            )
        })?
        .to_path_buf();

    Ok([profile_dir.clone(), profile_dir.join("examples")])
}

fn copy_unix_runtime_libs(lib_dir: &Path, target_os: &str) -> Result<(), DynError> {
    let runtime_libs: Vec<PathBuf> = fs::read_dir(lib_dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(OsStr::to_str)
                 .map(|name| match target_os {
                     "linux" | "android" => name.contains(".so"),
                     "macos" => name.ends_with(".dylib"),
                    _ => false,
                })
                .unwrap_or(false)
        })
        .collect();

    if runtime_libs.is_empty() {
        return Err(format!(
            "No shared runtime libraries found in {}",
            lib_dir.display()
        )
        .into());
    }

    let mut copy_plan = Vec::<(PathBuf, OsString)>::new();
    let mut planned_names = HashSet::<OsString>::new();

    for lib in runtime_libs {
        if !lib.exists() {
            continue;
        }

        let lib_name = lib
            .file_name()
            .ok_or_else(|| format!("Invalid runtime library path: {}", lib.display()))?
            .to_os_string();

        let source = fs::canonicalize(&lib).unwrap_or(lib.clone());
        if planned_names.insert(lib_name.clone()) {
            copy_plan.push((source.clone(), lib_name));
        }

        if let Some(source_name) = source.file_name() {
            let source_name = source_name.to_os_string();
            if planned_names.insert(source_name.clone()) {
                copy_plan.push((source.clone(), source_name));
            }
        }
    }

    if copy_plan.is_empty() {
        return Err(format!(
            "No usable shared runtime libraries found in {}",
            lib_dir.display()
        )
        .into());
    }

    for dest_dir in profile_output_dirs()? {
        fs::create_dir_all(&dest_dir)?;
        for (source, dest_name) in &copy_plan {
            let dest = dest_dir.join(dest_name);
            fs::copy(source, &dest)?;
        }
    }

    Ok(())
}

fn temp_path_for(path: &Path) -> PathBuf {
    let mut temp_name = path
        .file_name()
        .map(OsStr::to_os_string)
        .unwrap_or_else(|| OsString::from("tmp"));
    temp_name.push(".part");
    path.with_file_name(temp_name)
}

fn copy_file_atomically(src: &Path, dst: &Path) -> Result<(), DynError> {
    let temp_path = temp_path_for(dst);
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    fs::copy(src, &temp_path)?;
    fs::rename(&temp_path, dst)?;
    Ok(())
}

fn write_reader_atomically(reader: &mut dyn io::Read, dst: &Path) -> Result<(), DynError> {
    let temp_path = temp_path_for(dst);
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    {
        let mut file = File::create(&temp_path)?;
        io::copy(reader, &mut file)?;
        file.sync_all()?;
    }

    fs::rename(&temp_path, dst)?;
    Ok(())
}

fn copy_windows_runtime_dlls(lib_dir: &Path) -> Result<(), DynError> {
    let dlls: Vec<PathBuf> = fs::read_dir(lib_dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension() == Some(OsStr::new("dll")))
        .collect();

    if dlls.is_empty() {
        println!(
            "cargo:warning=No runtime DLLs found in {}",
            lib_dir.display()
        );
        return Ok(());
    }

    let [profile_dir, examples_dir] = profile_output_dirs()?;
    for dest_dir in [profile_dir.clone(), examples_dir] {
        fs::create_dir_all(&dest_dir)?;
        for dll in &dlls {
            let dest = dest_dir.join(
                dll.file_name()
                    .ok_or_else(|| format!("Invalid DLL path: {}", dll.display()))?,
            );
            fs::copy(dll, &dest)?;
        }
    }

    println!(
        "cargo:warning=Copied Windows runtime DLLs to {} and {}/examples",
        profile_dir.display(),
        profile_dir.display()
    );

    Ok(())
}

/// Digests the extracted tree, so a cache hit can be checked against the content
/// the linker will actually read rather than only against the archive it came
/// from.
///
/// Entries are hashed in sorted relative-path order with the path mixed in, so the
/// digest is stable across runs and independent of the order the filesystem
/// returns. Hashing the path means a renamed or added file changes the digest;
/// hashing the contents means a rewritten one does too.
///
/// File mode is deliberately not hashed. It is not part of what the linker reads
/// here, and hashing it would make the recorded digest platform-dependent for no
/// gain.
fn digest_extracted_tree(root: &Path) -> Result<String, DynError> {
    use std::io::Read as _;

    fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for path in entries {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                walk(root, &path, files)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push((relative, path));
            }
            // Anything that is neither a plain file nor a directory (a symlink, a
            // socket) is skipped rather than followed, so `read_dir` cannot walk
            // outside the cache root through a symlinked directory.
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (relative, path) in &files {
        hasher.update(relative.as_bytes());
        let mut file = File::open(path)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        // Length-delimited, so two different trees cannot concatenate to the same
        // byte stream and hash alike.
        hasher.update((relative.len() as u64).to_le_bytes());
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Writes the tree's digest beside it, so a later build can tell an untouched
/// cache from an altered one.
fn record_extracted_tree_digest(root: &Path, digest_path: &Path) -> Result<(), DynError> {
    let digest = digest_extracted_tree(root)?;
    write_atomic(&format!("{digest}\n"), digest_path)?;
    eprintln!(
        "Recorded extracted-tree SHA-256 for {}: {digest}",
        root.display()
    );
    Ok(())
}

/// Checks the extracted tree against the digest recorded for it.
///
/// Returns `Ok(false)` rather than failing the build when the tree cannot be
/// vouched for: no digest recorded yet, or the tree no longer matches. The caller
/// re-extracts from the archive it has already verified against its pinned digest,
/// which reproduces the official tree with no download. A hard failure here would
/// instead make the first build after this check was introduced fail permanently,
/// since no cache carries a recorded digest until one build has written one.
fn verify_extracted_tree(root: &Path, digest_path: &Path) -> Result<bool, DynError> {
    if !root.is_dir() {
        return Ok(false);
    }

    let recorded = match fs::read_to_string(digest_path) {
        Ok(text) => text.trim().to_ascii_lowercase(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            eprintln!(
                "No recorded digest for the extracted sherpa-onnx tree at {}",
                root.display()
            );
            return Ok(false);
        }
        Err(err) => return Err(err.into()),
    };

    if recorded.is_empty() {
        eprintln!(
            "Recorded digest for {} is empty, so the tree cannot be verified",
            root.display()
        );
        return Ok(false);
    }

    let actual = digest_extracted_tree(root)?;
    if actual.eq_ignore_ascii_case(&recorded) {
        return Ok(true);
    }

    eprintln!(
        "Extracted sherpa-onnx tree at {} does not match its recorded digest: expected {recorded}, got {actual}",
        root.display()
    );
    Ok(false)
}

/// Writes a small file atomically, so a reader never sees a half-written digest.
fn write_atomic(contents: &str, dest: &Path) -> Result<(), DynError> {
    let temp_path = temp_path_for(dest);
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    fs::write(&temp_path, contents.as_bytes())?;
    fs::rename(&temp_path, dest)?;
    Ok(())
}

fn verify_archive_digest(archive_path: &Path, archive_name: &str) -> Result<(), DynError> {
    use std::io::Read;

    let expected_digest = ARCHIVE_SHA256_DIGESTS
        .iter()
        .find(|(name, _)| *name == archive_name)
        .map(|(_, digest)| *digest)
        .ok_or_else(|| {
            format!(
                "No pinned SHA-256 digest found for archive '{archive_name}'. Refusing to unpack unverified asset."
            )
        })?;

    let mut file = File::open(archive_path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let actual_digest = format!("{:x}", hasher.finalize());

    if !actual_digest.eq_ignore_ascii_case(expected_digest) {
        let _ = fs::remove_file(archive_path);
        return Err(format!(
            "SHA-256 verification failed for {}: expected {}, got {}. The file has been deleted.",
            archive_path.display(),
            expected_digest,
            actual_digest
        )
        .into());
    }

    eprintln!("Verified SHA-256 for {archive_name}: {actual_digest}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A scratch directory under `OUT_DIR`-free temp space, unique per test so the
    /// suite never shares state. Removed on drop is not attempted: a leftover temp
    /// dir is harmless, a shared one is not.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "sherpa-tree-digest-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).expect("create scratch dir");
            Scratch(base)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(root: &Path, relative: &str, contents: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("has parent")).expect("create parent");
        fs::write(&path, contents).expect("write file");
    }

    /// A stand-in for an extracted sherpa tree: a `lib/` of plausible library files,
    /// which is the shape the cache check actually has to cope with.
    fn sample_tree(root: &Path) {
        write(root, "lib/libsherpa-onnx-c-api.a", b"c-api bytes");
        write(root, "lib/libsherpa-onnx-core.a", b"core bytes");
        write(root, "include/sherpa-onnx/c-api.h", b"header bytes");
    }

    #[test]
    fn digest_is_stable_across_calls() {
        let scratch = Scratch::new("stable");
        sample_tree(scratch.path());
        let first = digest_extracted_tree(scratch.path()).expect("digest");
        let second = digest_extracted_tree(scratch.path()).expect("digest");
        assert_eq!(first, second, "digest must not depend on read_dir order");
    }

    #[test]
    fn digest_changes_when_a_library_is_rewritten() {
        // The finding: a local process rewrites an extracted `.so`/`.a` while
        // leaving the archive byte-identical. The archive digest still passes, so
        // the tree digest is the only thing that can notice.
        let scratch = Scratch::new("rewrite");
        sample_tree(scratch.path());
        let before = digest_extracted_tree(scratch.path()).expect("digest");

        write(
            scratch.path(),
            "lib/libsherpa-onnx-core.a",
            b"core bytes, with an injected payload",
        );

        let after = digest_extracted_tree(scratch.path()).expect("digest");
        assert_ne!(
            before, after,
            "rewriting an extracted library must change the tree digest"
        );
    }

    #[test]
    fn digest_changes_when_a_file_is_added() {
        let scratch = Scratch::new("add");
        sample_tree(scratch.path());
        let before = digest_extracted_tree(scratch.path()).expect("digest");

        write(scratch.path(), "lib/libextra.a", b"extra");
        let after = digest_extracted_tree(scratch.path()).expect("digest");
        assert_ne!(before, after, "an added file must change the digest");
    }

    #[test]
    fn digest_changes_when_a_file_is_renamed_without_disturbing_the_sort_order() {
        // The linker resolves libraries by name, so a rename has to change the
        // digest. The names here are chosen so the renamed file keeps its position
        // in sorted order and the file keeps its length, which means a digest built
        // only from the byte stream — contents in sorted order, no paths — is
        // unchanged by this rename and must therefore be caught here.
        let scratch = Scratch::new("rename");
        write(scratch.path(), "lib/aaa.a", b"first file bytes");
        write(scratch.path(), "lib/zzz.a", b"second file bytes");
        let before = digest_extracted_tree(scratch.path()).expect("digest");

        // Same length as "aaa.a", and still sorts before "zzz.a".
        fs::rename(
            scratch.path().join("lib/aaa.a"),
            scratch.path().join("lib/aab.a"),
        )
        .expect("rename");
        // Stated rather than assumed: this is the property that makes the case
        // discriminating, so a future edit to the names must trip it.
        assert_eq!(
            "lib/aab.a".len(),
            "lib/aaa.a".len(),
            "precondition: the new name is the same length as the old one"
        );
        assert!(
            "lib/aab.a" < "lib/zzz.a",
            "precondition: the renamed file keeps its position in sort order"
        );

        let after = digest_extracted_tree(scratch.path()).expect("digest");
        assert_ne!(
            before, after,
            "a renamed library must change the digest even when the sort order and \
             the file length are unchanged"
        );
    }

    #[test]
    fn digest_distinguishes_content_swapped_between_two_paths() {
        // Two files whose contents are exchanged hash alike if the path is not mixed
        // in, so this pins that the path really is part of the digest.
        let a = Scratch::new("swap-a");
        let b = Scratch::new("swap-b");
        write(a.path(), "lib/one.a", b"first");
        write(a.path(), "lib/two.a", b"second");
        write(b.path(), "lib/one.a", b"second");
        write(b.path(), "lib/two.a", b"first");
        assert_ne!(
            digest_extracted_tree(a.path()).expect("digest a"),
            digest_extracted_tree(b.path()).expect("digest b"),
            "swapping contents between two paths must change the digest"
        );
    }

    #[test]
    fn verify_accepts_an_untouched_tree_and_rejects_a_rewritten_one() {
        let scratch = Scratch::new("verify");
        let tree = scratch.path().join("tree");
        fs::create_dir_all(&tree).expect("create tree");
        let digest_path = scratch.path().join("tree.sha256");
        sample_tree(&tree);

        // No digest recorded yet: unverifiable, not an error. This is the state
        // every cache is in on the first build after the check was introduced.
        assert!(
            !verify_extracted_tree(&tree, &digest_path).expect("verify"),
            "a tree with no recorded digest must not be accepted"
        );

        record_extracted_tree_digest(&tree, &digest_path).expect("record");
        assert!(
            verify_extracted_tree(&tree, &digest_path).expect("verify"),
            "an untouched tree must verify against its own recorded digest"
        );

        write(&tree, "lib/libsherpa-onnx-core.a", b"tampered");
        assert!(
            !verify_extracted_tree(&tree, &digest_path).expect("verify"),
            "a rewritten library must not verify"
        );
    }

    #[test]
    fn verify_rejects_an_empty_recorded_digest() {
        let scratch = Scratch::new("empty");
        let tree = scratch.path().join("tree");
        fs::create_dir_all(&tree).expect("create tree");
        sample_tree(&tree);
        let digest_path = scratch.path().join("tree.sha256");
        fs::write(&digest_path, "   \n").expect("write empty digest");
        assert!(
            !verify_extracted_tree(&tree, &digest_path).expect("verify"),
            "an empty recorded digest must not be treated as a match"
        );
    }

    #[test]
    fn verify_rejects_a_missing_tree() {
        let scratch = Scratch::new("missing");
        let digest_path = scratch.path().join("tree.sha256");
        fs::write(&digest_path, "deadbeef\n").expect("write digest");
        assert!(
            !verify_extracted_tree(&scratch.path().join("absent"), &digest_path).expect("verify"),
            "a missing tree must not verify"
        );
    }

    #[test]
    fn record_is_case_insensitive_on_read_back() {
        // The digest is stored as hex and compared with `eq_ignore_ascii_case`, so an
        // uppercase recording of the same value must still verify.
        let scratch = Scratch::new("case");
        let tree = scratch.path().join("tree");
        fs::create_dir_all(&tree).expect("create tree");
        sample_tree(&tree);
        let digest_path = scratch.path().join("tree.sha256");

        record_extracted_tree_digest(&tree, &digest_path).expect("record");
        let lower = fs::read_to_string(&digest_path).expect("read");
        fs::write(&digest_path, lower.trim().to_ascii_uppercase()).expect("rewrite");

        assert!(
            verify_extracted_tree(&tree, &digest_path).expect("verify"),
            "hex comparison must be case-insensitive"
        );
    }
}

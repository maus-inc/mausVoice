use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::{collections::HashSet, ffi::OsString};

// Only the test-only pinned-digest override and the test harness's environment
// lock need this, and neither is compiled into the build script cargo runs, so
// importing it unconditionally would warn on every real build.
#[cfg(test)]
use std::sync::Mutex;

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

    // Verifying the archive is necessary but not sufficient. The pinned digest
    // covers the archive; the linker reads the *extracted* `.so`/`.a` files. A
    // process that rewrites a library under `extracted_dir` after extraction leaves
    // the archive byte-identical, so the pinned digest still passes and the
    // modified content gets linked. The extracted tree therefore carries a digest
    // of its own, recorded beside it, and the cache is reused only while that still
    // matches.
    //
    // Stating the limit of that, because the previous wording here claimed more
    // than it had. The recorded digest is a sibling of the tree in the same
    // `cache_root`, with nothing separating them: no permission hardening, no
    // separate directory, nothing outside what the tree's own writer can reach. So
    // a process able to rewrite a library can also rewrite the digest beside it to
    // match, and then the tree verifies -- the check is not a boundary against a
    // local writer with access to the cache directory. Deleting the digest is the
    // lesser case: it reads as unverifiable rather than as a match, so it costs a
    // re-extract and nothing else.
    //
    // What it does buy is real, and is what the recorded digest is for: the tree is
    // unchanged across incidental alteration -- an interrupted or partial unpack, a
    // tree left behind by a different archive, bit rot, another build step touching
    // it -- and it is checked against a process that can write the tree but not the
    // file beside it. Hardening against a same-uid writer would need the expected
    // digest derived from the verified archive rather than read back from the
    // cache, which is a larger change than this one.
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

/// Framing tag prefixed to the hashed stream.
///
/// A digest recorded under one framing must never be read as a match under
/// another, and two framings can in principle hash some tree identically. The tag
/// removes the question by making the framings disjoint at the first byte. Bump it
/// whenever the layout in `digest_extracted_tree` changes: every existing cache
/// then reads as unverifiable and is re-extracted once, which is the same path a
/// tampered tree already takes, so the cost is one redundant unpack per machine.
const TREE_DIGEST_LAYOUT_VERSION: u64 = 1;

/// Digests the extracted tree, so a cache hit can be checked against the content
/// the linker will actually read rather than only against the archive it came
/// from.
///
/// Entries are hashed in sorted relative-path order, so the digest is stable across
/// runs and independent of the order the filesystem returns. Hashing the path means
/// a renamed or added file changes the digest; hashing the contents means a
/// rewritten one does too.
///
/// # Framing, and why every field is length-delimited
///
/// Each entry contributes its path length, its path, its content length and its
/// content, in that order, after a `TREE_DIGEST_LAYOUT_VERSION` tag. Both lengths
/// are fixed-width little-endian `u64` counts of the bytes that follow them.
///
/// What that buys is a stream with exactly one parse: a reader can step through it
/// entry by entry and always know where each path ends and where each file's
/// content ends. Two different sequences of (path, content) pairs therefore cannot
/// produce the same byte stream.
///
/// This is not a property the framing used to have, and the difference is not
/// cosmetic. It hashed `path || content || len(path)`: the length trailed the very
/// content it was supposed to delimit, and the content field was unbounded, so
/// nothing stopped the stream being re-cut. A three-file tree and a *one*-file
/// tree whose single file held the middle of the three-file stream were the same
/// byte stream and so had the same SHA-256 -- with neither of the other two files
/// present. Every suffix merge collided, not just the one-file case. Moving the
/// path length in front of the path fixes none of it: `len(path) || path ||
/// content` is re-parsable for exactly the same reason, and collides the same way.
/// A length only delimits if it delimits *something*; the unbounded content field
/// is what made both layouts ambiguous, so the content length is not optional.
///
/// The path length is here for the same reason, not because the content length
/// already covered it. Dropping it gives `path || len(content) || content`, whose
/// stream is ambiguous in the same abstract sense -- one entry's bytes can be read
/// as the next entry's path -- and it is worth being precise about how far that
/// goes, because the two framings are not equally weak. Such a forgery needs the
/// absorbing file's *name* to contain the 8-byte length field of an entry it
/// swallowed, and for any real length those bytes include NUL, which no POSIX
/// filesystem permits in a filename. So that ambiguity cannot be reached through a
/// tree that was actually extracted. It is still the wrong shape to rely on: it is
/// safe only because of a filesystem restriction this function does not enforce and
/// cannot check, it would stop holding for any store that permits such a name, and
/// the path length costs eight bytes. Delimiting both fields means the property
/// comes from the format instead of from the platform.
///
/// What the framing still does not give: an injective stream says the digest is a
/// faithful statement about the (path, content) pairs the walk yields, and nothing
/// more. File mode is deliberately not hashed -- it is not what the linker reads
/// here, and hashing it would make the digest platform-dependent for no gain. An
/// entry that is not a plain file is not hashed at all (see `walk` below). And
/// none of this is a claim about who may write to the tree or to the file the
/// digest is recorded in; `verify_extracted_tree` is where that boundary is stated.
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
            // An entry that is neither a plain file nor a directory -- a symlink, a
            // socket -- is skipped rather than followed. Two different things follow
            // from that, and only one of them is a safety property.
            //
            // For *traversal* it is the right behaviour, and is what this comment
            // used to be about: the recursion only ever descends into real
            // directories, so a symlink planted in the tree cannot lead the walk out
            // of the cache root and have whatever it points at hashed as though it
            // were part of the tree.
            //
            // For *integrity* it is a limit, not a safeguard, and the older wording
            // was silent about it. A symlink is not hashed at all, so adding one to
            // an otherwise untouched tree leaves the digest unchanged: such a tree
            // verifies. That is narrower than "the digest covers everything under
            // the tree", and the linker does follow a symlink planted where it
            // expects a library. Closing it means hashing the link target too, which
            // this does not do.
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    hasher.update(TREE_DIGEST_LAYOUT_VERSION.to_le_bytes());
    for (relative, path) in &files {
        let mut file = File::open(path)?;
        // Read the content in one piece rather than streaming it, so the length
        // written into the stream is by construction the number of bytes hashed
        // after it. A two-pass version that took the length from `metadata()` and
        // then streamed could disagree with itself if the file changed underneath,
        // which is the one thing the framing above exists to make impossible.
        let mut content = Vec::new();
        file.read_to_end(&mut content)?;
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update((content.len() as u64).to_le_bytes());
        hasher.update(&content);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Writes the tree's digest beside it, so a later build can tell an untouched
/// cache from an altered one.
///
/// "Beside it" is also the limit: the digest is only as trustworthy as the directory
/// holding it. See the block comment in `download_prebuilt_libs` for what a
/// recorded digest does and does not defend against.
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
///
/// `Ok(true)` means the tree hashes to the recorded digest and nothing more. It is
/// not a statement that the tree is safe to link against an adversary: the recorded
/// digest lives beside the tree and can be rewritten by whoever can rewrite it. See
/// `download_prebuilt_libs`.
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

/// Marker string that exists only in a `cfg(test)` build of this file.
///
/// `scripts/ci/sherpa-build-script-tests.mjs` compiles this file twice — once the
/// way cargo does, and once with `--test` — and asserts that this literal is
/// present in the test build's binary and absent from the build script cargo
/// actually runs. That is how the statement "the override below cannot reach a
/// real build" is checked rather than merely asserted in a comment.
#[cfg(test)]
const PINNED_DIGEST_OVERRIDE_MARKER: &str = "sherpa-pinned-digest-override-cfg-test-only";

/// One `(archive name, digest)` pair a test has asked `pinned_archive_digest` to
/// accept, or `None` when no test has.
///
/// `cfg(test)` because cargo builds a build script as an ordinary binary and never
/// under `--test`, so this static is not compiled into the artifact any build
/// runs — see `PINNED_DIGEST_OVERRIDE_MARKER` and the harness that checks it.
/// `Mutex` because the test harness runs tests on several threads in one process
/// and this is process-wide state.
#[cfg(test)]
static PINNED_DIGEST_OVERRIDE: Mutex<Option<(String, String)>> = Mutex::new(None);

/// The pinned SHA-256 digest for `archive_name`, or `None` when that name is not
/// pinned at all.
///
/// Split out of `verify_archive_digest` so the one place a digest is looked up can
/// be the one place a test supplies one. `verify_archive_digest` refuses any
/// archive it cannot match against a pin, and a test cannot produce a 22 MB
/// official release tarball byte-for-byte, so the wiring tests below — which drive
/// `download_prebuilt_libs` end to end and need the archive check to genuinely
/// pass — would otherwise be unable to reach the code under test at all.
fn pinned_archive_digest(archive_name: &str) -> Option<String> {
    #[cfg(test)]
    {
        if let Ok(guard) = PINNED_DIGEST_OVERRIDE.lock() {
            if let Some((name, digest)) = guard.as_ref() {
                if name == archive_name {
                    return Some(digest.clone());
                }
            }
        }
    }

    ARCHIVE_SHA256_DIGESTS
        .iter()
        .find(|(name, _)| *name == archive_name)
        .map(|(_, digest)| (*digest).to_string())
}

fn verify_archive_digest(archive_path: &Path, archive_name: &str) -> Result<(), DynError> {
    use std::io::Read;

    let expected_digest = pinned_archive_digest(archive_name).ok_or_else(|| {
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

    if !actual_digest.eq_ignore_ascii_case(&expected_digest) {
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

    // ------------------------------------------------------------------
    // The tests above exercise the pure helpers. They cannot see the
    // decision this whole change exists to make: whether a cache hit is
    // taken at all. Restoring the original behaviour -- reusing an
    // extracted tree without consulting `verify_extracted_tree` -- leaves
    // every one of them green, because none of them calls
    // `download_prebuilt_libs`. The tests below do.
    // ------------------------------------------------------------------

    /// The target the wiring tests drive. Linux/x64 static is the combination
    /// `rust_transcription` actually builds, and it is the one whose archive the
    /// pinned table holds.
    const WIRING_OS: &str = "linux";
    const WIRING_ARCH: &str = "x86_64";

    /// Serialises the wiring tests against each other.
    ///
    /// They set process-wide environment variables, because the cache root and
    /// the archive source are the only inputs `download_prebuilt_libs` takes and it
    /// reads both from the environment. The test harness runs tests on several
    /// threads in one process, so without this two of these tests could interleave
    /// their environment and read each other's cache. The pure-helper tests above
    /// touch no environment and so do not take it.
    static WIRING_ENV: Mutex<()> = Mutex::new(());

    /// The environment variables `download_prebuilt_libs` and its callees read.
    /// All of them are cleared and then set, so a value inherited from whatever
    /// invoked the test binary cannot redirect a cache.
    const WIRING_ENV_VARS: &[&str] = &[
        "OUT_DIR",
        "CARGO_TARGET_DIR",
        "SHERPA_ONNX_ARCHIVE_DIR",
        "SHERPA_ONNX_LIB_DIR",
        "DOCS_RS",
    ];

    /// Owns the environment `download_prebuilt_libs` reads, for one test.
    struct WiringEnv {
        cache_root: PathBuf,
        previous: Vec<(String, Option<OsString>)>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl WiringEnv {
        fn new(scratch: &Scratch, tag: &str) -> Self {
            // `unwrap_or_else` rather than `unwrap`: a test that panicked while
            // holding the lock poisons it, and the tests that follow must still run
            // and report their own failures rather than dying on someone else's.
            let guard = WIRING_ENV.lock().unwrap_or_else(|err| err.into_inner());

            let root = scratch.path().join(tag);
            // `OUT_DIR` is never read on this path -- `target_dir_from_out_dir`
            // prefers `CARGO_TARGET_DIR` -- but `download_prebuilt_libs` calls
            // `env::var("OUT_DIR")` unconditionally, so it has to be present.
            let out_dir = root.join("debug/build/sherpa-onnx-sys-test/out");
            fs::create_dir_all(&out_dir).expect("create out dir");
            // Empty on purpose: any attempt to source the archive from here fails
            // with "does not contain expected archive" instead of quietly succeeding.
            let archive_dir = root.join("archive-dir");
            fs::create_dir_all(&archive_dir).expect("create archive dir");

            let previous: Vec<(String, Option<OsString>)> = WIRING_ENV_VARS
                .iter()
                .map(|name| ((*name).to_string(), env::var_os(name)))
                .collect();
            for name in WIRING_ENV_VARS {
                env::remove_var(name);
            }
            env::set_var("OUT_DIR", &out_dir);
            env::set_var("CARGO_TARGET_DIR", &root);
            env::set_var("SHERPA_ONNX_ARCHIVE_DIR", &archive_dir);

            WiringEnv {
                cache_root: root.join("sherpa-onnx-prebuilt"),
                previous,
                _guard: guard,
            }
        }

        /// `cache_root/<stem>`, where `stem` is the archive name without its
        /// extension: the directory `download_prebuilt_libs` extracts into.
        fn extracted_dir(&self, stem: &str) -> PathBuf {
            self.cache_root.join(stem)
        }

        /// The path of the tree digest recorded beside the extracted tree.
        fn tree_digest_path(&self, stem: &str) -> PathBuf {
            self.cache_root.join(format!("{stem}.extracted.sha256"))
        }

        fn archive_path(&self, stem: &str) -> PathBuf {
            self.cache_root.join(format!("{stem}.tar.bz2"))
        }

        /// The `lib/` directory of the extracted tree, which is what a build script
        /// caller goes on to link against.
        fn lib_dir(&self, stem: &str) -> PathBuf {
            self.extracted_dir(stem).join("lib")
        }
    }

    impl Drop for WiringEnv {
        fn drop(&mut self) {
            // The digest override is process-wide too, and test order is not
            // guaranteed, so an override left behind by one wiring test would decide
            // whether a later test sees the pinned table or the test's stand-in for
            // it. Cleared here, under the same lock held for the whole test, so the
            // next one starts from the production lookup.
            let _ = PINNED_DIGEST_OVERRIDE
                .lock()
                .expect("pinned digest override lock")
                .take();
            // Restored even on panic: the harness shares one process across every
            // test in this binary, and a leaked `OUT_DIR` or
            // `SHERPA_ONNX_ARCHIVE_DIR` would silently redirect some other test's
            // cache.
            for (name, value) in &self.previous {
                match value {
                    Some(value) => env::set_var(name, value),
                    None => env::remove_var(name),
                }
            }
        }
    }

    /// The libraries a synthetic prebuilt archive contains, named and shaped like
    /// the ones the linker reads out of a real extracted tree.
    const SYNTHETIC_LIBS: &[(&str, &[u8])] = &[
        ("libsherpa-onnx-c-api.a", b"official c-api bytes"),
        ("libsherpa-onnx-core.a", b"official core bytes"),
    ];

    /// What a tampered extracted tree looks like: the archive's own libraries, with a
    /// payload substituted for one of them. A function rather than a `const` only so
    /// the name reads as the thing it is at each call site.
    fn tampered_core_bytes() -> &'static [u8] {
        b"core bytes, plus whatever a local process wrote"
    }

    /// Builds a small `.tar.bz2` with the layout of a real prebuilt archive:
    /// `<stem>/lib/*.a`, which is what `download_prebuilt_libs` unpacks and links.
    ///
    /// Written with the same `bzip2` and `tar` crates the build script uses to read
    /// one, rather than assembled by hand, so the fixture exercises the real unpack
    /// path. Returns the archive's SHA-256.
    fn write_synthetic_archive(dest: &Path, stem: &str) -> String {
        fs::create_dir_all(dest.parent().expect("archive has a parent")).expect("create parent");
        let file = File::create(dest).expect("create archive");
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::best());
        let mut builder = tar::Builder::new(encoder);
        for &(name, contents) in SYNTHETIC_LIBS {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, format!("{stem}/lib/{name}"), contents)
                .expect("append entry");
        }
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish bzip2");

        sha256_hex(dest)
    }

    /// The archive name and directory name `download_prebuilt_libs` will use for
    /// this target, taken from the production mapping rather than written out, so a
    /// change to `archive_name` cannot leave these tests building a different
    /// archive than a real build would.
    fn wiring_archive_name() -> String {
        archive_name(LinkMode::Static, WIRING_OS, WIRING_ARCH).expect("archive name")
    }

    fn wiring_stem() -> String {
        wiring_archive_name()
            .trim_end_matches(".tar.bz2")
            .to_string()
    }

    /// Puts a verified archive in the cache the way a previous build would have
    /// left it, and installs its digest as the pinned one.
    ///
    /// The override is the single thing these tests take on trust. `verify_archive_digest`
    /// itself runs unmodified; what a real build would compare against a pin, these
    /// compare against the archive's actual digest, so a mutation that changes the
    /// comparison, the deletion-on-mismatch, or the lookup still turns them red.
    fn prime_cache(env: &WiringEnv, stem: &str) -> PathBuf {
        let archive_path = env.archive_path(stem);
        let digest = write_synthetic_archive(&archive_path, stem);
        PINNED_DIGEST_OVERRIDE
            .lock()
            .expect("pinned digest override lock")
            .replace((format!("{stem}.tar.bz2"), digest));
        archive_path
    }

    fn sha256_hex(path: &Path) -> String {
        use std::io::Read as _;

        let mut file = File::open(path).expect("open for digest");
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buffer).expect("read for digest");
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        format!("{:x}", hasher.finalize())
    }

    fn read_lib(lib_dir: &Path, name: &str) -> Vec<u8> {
        fs::read(lib_dir.join(name)).expect("read library")
    }

    fn run_wiring() -> Result<PathBuf, DynError> {
        download_prebuilt_libs(LinkMode::Static, WIRING_OS, WIRING_ARCH)
    }

    #[test]
    fn a_tampered_extracted_tree_is_not_reused() {
        // The regression this change exists to prevent. The archive still matches its
        // pinned digest, so only the tree digest can notice that the file the linker
        // will read has been rewritten underneath the build.
        let scratch = Scratch::new("wiring-tamper");
        let env = WiringEnv::new(&scratch, "cache");
        let stem = wiring_stem();
        let archive_path = prime_cache(&env, &stem);

        // First build: archive present, nothing extracted. Extracts and records.
        let lib_dir = run_wiring().expect("cold cache must extract");
        assert_eq!(lib_dir, env.lib_dir(&stem), "unexpected lib dir");
        assert_eq!(
            read_lib(&lib_dir, "libsherpa-onnx-core.a"),
            SYNTHETIC_LIBS[1].1,
            "precondition: the cold extraction unpacked the archive's own library"
        );
        assert!(
            env.tree_digest_path(&stem).is_file(),
            "precondition: a successful extraction records the tree digest"
        );

        // Tamper with the extracted tree, leaving the archive byte-identical -- which
        // is the whole difficulty: the pinned archive digest still passes.
        fs::write(lib_dir.join("libsherpa-onnx-core.a"), tampered_core_bytes())
            .expect("tamper with the extracted library");
        assert_eq!(
            read_lib(&lib_dir, "libsherpa-onnx-core.a"),
            tampered_core_bytes(),
            "precondition: the extracted library now differs from the archive's"
        );
        verify_archive_digest(&archive_path, &wiring_archive_name()).expect(
            "precondition: the archive still passes its own digest check, so only the \
             tree digest can reject this cache",
        );

        // Second build: must not link the tampered library.
        let returned = run_wiring().expect("a tampered tree must be repaired, not fatal");

        assert_ne!(
            read_lib(&returned, "libsherpa-onnx-core.a"),
            tampered_core_bytes(),
            "the tampered library was handed back to be linked: the cache hit \
             ignored the recorded tree digest"
        );
        assert_eq!(
            read_lib(&returned, "libsherpa-onnx-core.a"),
            SYNTHETIC_LIBS[1].1,
            "the repair must restore the archive's own library"
        );
    }

    #[test]
    fn a_tree_with_no_recorded_digest_is_not_reused() {
        // Every cache predating this check is in exactly this state: an extracted
        // tree, a verified archive beside it, and nothing recording what the tree
        // should look like. Reusing that silently is what would link an
        // unverifiable directory on the first build after the change shipped.
        let scratch = Scratch::new("wiring-norecord");
        let env = WiringEnv::new(&scratch, "cache");
        let stem = wiring_stem();
        prime_cache(&env, &stem);

        let lib_dir = env.lib_dir(&stem);
        fs::create_dir_all(&lib_dir).expect("create lib dir");
        fs::write(lib_dir.join("libsherpa-onnx-core.a"), tampered_core_bytes())
            .expect("seed a tree from an older build");
        assert!(
            !env.tree_digest_path(&stem).exists(),
            "precondition: no digest is recorded for this tree"
        );

        let returned = run_wiring().expect("an unrecorded tree must be re-extracted, not fatal");

        assert_ne!(
            read_lib(&returned, "libsherpa-onnx-core.a"),
            tampered_core_bytes(),
            "the unrecorded tree was handed back to be linked: a cache hit with no \
             recorded digest was treated as verified"
        );
        assert!(
            env.tree_digest_path(&stem).is_file(),
            "the re-extracted tree must have had its digest recorded, or the next \
             build would have to re-extract it again"
        );
        assert!(
            verify_extracted_tree(&env.extracted_dir(&stem), &env.tree_digest_path(&stem))
                .expect("verify"),
            "the tree the build went on to link must verify against its own digest"
        );
    }

    #[test]
    fn the_repair_path_re_extracts_instead_of_downloading() {
        // The repair must come from the archive already sitting in the cache, which
        // was just verified against its digest: re-downloading 22 MB to fix a local
        // tamper would be both slower and a second thing that can fail.
        //
        // "Instead of downloading" is asserted by the tripwire rather than by
        // inspection. `SHERPA_ONNX_ARCHIVE_DIR` is an empty directory for every
        // wiring test, so the copy-from-directory branch -- the only branch left
        // once the archive is present -- cannot succeed; and with that variable set
        // the download branch is unreachable. A repair that returned `Ok` therefore
        // had to read the cached archive.
        let scratch = Scratch::new("wiring-repair");
        let env = WiringEnv::new(&scratch, "cache");
        let stem = wiring_stem();
        let archive_path = prime_cache(&env, &stem);

        let lib_dir = run_wiring().expect("cold cache must extract");
        fs::write(lib_dir.join("libsherpa-onnx-core.a"), tampered_core_bytes())
            .expect("tamper with the extracted library");
        let archive_digest_before = sha256_hex(&archive_path);

        let returned = run_wiring().expect("repair from the cached archive");

        assert_eq!(
            read_lib(&returned, "libsherpa-onnx-core.a"),
            SYNTHETIC_LIBS[1].1,
            "the repair must unpack the archive's own library"
        );
        assert_eq!(
            sha256_hex(&archive_path),
            archive_digest_before,
            "the repair must not have rewritten the archive in the cache"
        );
        assert!(
            verify_extracted_tree(&env.extracted_dir(&stem), &env.tree_digest_path(&stem))
                .expect("verify"),
            "the repaired tree must verify against its recorded digest"
        );
    }

    #[test]
    fn a_tree_whose_archive_is_missing_is_not_reused() {
        // The other unverifiable-cache state: the extracted tree is present but the
        // archive it came from has gone, so nothing about it traces back to a pinned
        // digest even if a digest for it is recorded.
        let scratch = Scratch::new("wiring-noarchive");
        let env = WiringEnv::new(&scratch, "cache");
        let stem = wiring_stem();

        let lib_dir = env.lib_dir(&stem);
        fs::create_dir_all(&lib_dir).expect("create lib dir");
        fs::write(lib_dir.join("libsherpa-onnx-core.a"), tampered_core_bytes())
            .expect("seed a tree");
        // A recorded digest that matches, so the only thing left to reject this tree
        // is the archive being gone.
        record_extracted_tree_digest(&env.extracted_dir(&stem), &env.tree_digest_path(&stem))
            .expect("record");
        assert!(
            !env.archive_path(&stem).exists(),
            "precondition: there is no archive"
        );
        assert!(
            verify_extracted_tree(&env.extracted_dir(&stem), &env.tree_digest_path(&stem))
                .expect("verify"),
            "precondition: the tree verifies against its own recorded digest"
        );

        // No archive and an empty `SHERPA_ONNX_ARCHIVE_DIR`, so the honest outcome is
        // a failure to find the archive -- not a directory to link.
        let err = run_wiring().expect_err("an unverifiable tree must not be linked");
        let message = err.to_string();
        assert!(
            message.contains("does not contain expected archive"),
            "unexpected failure reason: {message}"
        );
        assert!(
            !env.extracted_dir(&stem).exists(),
            "the unverifiable tree must be discarded, not left for the next build"
        );
        assert!(
            !env.tree_digest_path(&stem).exists(),
            "the digest describing a discarded tree must go with it, or a later \
             extraction that differed would be re-extracted forever"
        );
    }

    /// Moving a byte across a file boundary must change the digest.
    ///
    /// This is the layout-independent form of the collision test below, and it is
    /// the one that matters most. Every way this digest has been wrong came from the
    /// same root: the hashed stream did not record *where one file's content ends
    /// and the next entry begins*, so the same bytes could be re-cut into a
    /// different set of files. `splice_suffix` checks that against one historical
    /// framing; this checks the property itself, and so survives the framing being
    /// changed again.
    ///
    /// Each case holds the total byte content of the tree fixed and moves one byte
    /// across a boundary between two files -- `a` gains what `b` loses, and `b`
    /// shrinks by one. The two trees contain the same bytes in the same order. The
    /// only thing that differs is where the split falls, so any layout that fails
    /// to encode the split gives them the same digest, which is precisely a
    /// re-parseable stream.
    #[test]
    fn moving_a_byte_across_a_file_boundary_changes_the_digest() {
        let scratch = Scratch::new("boundary");
        let left = scratch.path().join("left");
        let right = scratch.path().join("right");

        // Same 12 bytes either way; only the split point moves.
        write(&left, "lib/one.a", b"AAAA");
        write(&left, "lib/two.a", b"BBBB");
        write(&right, "lib/one.a", b"AAAAB");
        write(&right, "lib/two.a", b"BBB");

        let mut all = Vec::new();
        for tree in [&left, &right] {
            let mut bytes = Vec::new();
            for name in ["lib/one.a", "lib/two.a"] {
                bytes.extend_from_slice(&fs::read(tree.join(name)).expect("read"));
            }
            all.push(bytes);
        }
        assert_eq!(
            all[0], all[1],
            "precondition: the two trees hold the same bytes in the same order, so \
             only the file boundary differs"
        );

        assert_ne!(
            digest_extracted_tree(&left).expect("digest"),
            digest_extracted_tree(&right).expect("digest"),
            "moving one byte from one library into the next did not change the tree \
             digest. The hashed stream must record where each file's content ends, \
             or the same bytes re-cut into different files hash alike -- which is \
             how a tree missing most of its libraries can pass as verified."
        );
    }

    /// Splices files `keep..` into the content of file `keep - 1` and drops them,
    /// returning the resulting file list.
    ///
    /// This builds a forgery for the framing `digest_extracted_tree` used to have,
    /// `path || content || len(path)`, under which every such splice hashed
    /// identically to the original: the merged content ends exactly where the
    /// trailing length field used to be, so as long as the merged file's name is as
    /// long as the last original one, the streams are byte-identical. `keep == 1` is
    /// the extreme case, a one-file tree standing in for an n-file one with none of
    /// the others present.
    ///
    /// The bytes are written out here rather than derived from whatever the encoder
    /// currently is. A forgery computed from the encoder would agree with it by
    /// construction and so would assert nothing at all -- which is how the original
    /// layout survived a suite that only ever fed it honest trees. Under the current
    /// framing these bytes are nothing but file content.
    fn splice_suffix(files: &[(&str, &[u8])], keep: usize) -> Vec<(String, Vec<u8>)> {
        assert!(
            (1..=files.len()).contains(&keep),
            "keep {keep} is outside 1..={}",
            files.len()
        );
        let mut spliced: Vec<(String, Vec<u8>)> = files[..keep - 1]
            .iter()
            .map(|(name, bytes)| ((*name).to_string(), bytes.to_vec()))
            .collect();

        let (name, bytes) = files[keep - 1];
        let mut content = bytes.to_vec();
        for (next_name, next_bytes) in &files[keep..] {
            content.extend_from_slice(&(next_name.len() as u64).to_le_bytes());
            content.extend_from_slice(next_name.as_bytes());
            content.extend_from_slice(next_bytes);
        }
        spliced.push((name.to_string(), content));
        spliced
    }

    /// An honest tree, and the forgeries that used to hash identically to it.
    ///
    /// Every case is already in the sorted order the digest walks in, and within a
    /// case all the paths share a length -- the first condition so `splice_suffix`
    /// lines the merged content up with the old trailing field, the second so the
    /// precondition holds for every `keep`. Both are asserted by the test rather than
    /// assumed, because they are what make the case discriminating.
    const FORGERY_CASES: &[&[(&str, &[u8])]] = &[
        &[
            ("a", b"first file bytes" as &[u8]),
            ("b", b"second file bytes"),
            ("c", b"third file bytes"),
        ],
        &[("lib/one.a", b"one"), ("lib/two.a", b"two")],
        &[("etc", b"e"), ("inc", b"i"), ("lib", b"l"), ("obj", b"o")],
    ];

    #[test]
    fn a_forged_tree_is_not_accepted_as_the_tree_whose_digest_it_carries() {
        // The regression. The digest was computed over a stream with no framing on
        // the content field, so a tree could be re-cut into a different and shorter
        // file list that hashed the same. A green suite did not find it because
        // every other test here feeds the digest honest trees; nothing ever tried to
        // make two different trees agree, which is the only thing that can.
        //
        // Each case is a real multi-file tree, and for every way of merging a suffix
        // of it into one of its own files, a real tree that is genuinely missing
        // those files. The digest recorded is the honest tree's own, as a real
        // extraction leaves it, and the forgery is what an attacker would put in the
        // tree's place.
        for (case, files) in FORGERY_CASES.iter().enumerate() {
            for pair in files.windows(2) {
                assert!(
                    pair[0].0 < pair[1].0,
                    "precondition: the case is listed in the sorted order the digest \
                     walks in, but {:?} sorts before {:?}",
                    pair[1].0,
                    pair[0].0
                );
                assert_eq!(
                    pair[0].0.len(),
                    pair[1].0.len(),
                    "precondition: every path in a case shares a length, so the \
                     splice lines up under the old framing for any `keep`"
                );
            }

            let scratch = Scratch::new(&format!("forged-{case}"));
            let honest = scratch.path().join("honest");
            for (name, bytes) in *files {
                write(&honest, name, bytes);
            }
            let digest_path = scratch.path().join("honest.sha256");
            record_extracted_tree_digest(&honest, &digest_path).expect("record");
            let honest_digest = fs::read_to_string(&digest_path).expect("read recorded digest");

            // `keep == files.len()` is the identity splice -- merge nothing -- and so
            // is not a forgery. Every other value drops at least one file.
            for keep in 1..files.len() {
                let spliced = splice_suffix(files, keep);
                assert!(
                    spliced.len() < files.len(),
                    "the forgery must genuinely be missing files, not the same tree"
                );

                let forged = scratch.path().join(format!("forged-{keep}"));
                for (name, bytes) in &spliced {
                    write(&forged, name, bytes);
                }

                assert!(
                    !verify_extracted_tree(&forged, &digest_path).expect("verify"),
                    "case {case}, keep {keep}: a {}-file forgery of a {}-file tree \
                     verified against that tree's own recorded digest {}. The digest \
                     stream has no framing on the content field, so these bytes \
                     parse as a shorter file list; {} of the original files are \
                     absent from the forgery.",
                    spliced.len(),
                    files.len(),
                    honest_digest.trim(),
                    files.len() - spliced.len()
                );
                assert_ne!(
                    digest_extracted_tree(&forged).expect("digest"),
                    honest_digest.trim(),
                    "case {case}, keep {keep}: the forgery and the tree it replaces \
                     hash the same"
                );
            }
        }
    }

    #[test]
    fn pinned_digests_come_from_the_table_for_every_pinned_archive() {
        // `pinned_archive_digest` is the one place a digest is looked up, and every
        // wiring test below installs the `cfg(test)` override, which is consulted
        // first. Left alone, the branch that reads `ARCHIVE_SHA256_DIGESTS` would
        // therefore never be taken by a test: deleting it outright — checked by
        // mutation — leaves every other test green, and it is the branch every real
        // build goes through. Checked here directly instead.
        //
        // Takes the wiring lock because the override is process-wide: without it this
        // could read an override a wiring test installed, and fail for that reason
        // rather than for the one it is checking.
        let _guard = WIRING_ENV.lock().unwrap_or_else(|err| err.into_inner());
        assert!(
            PINNED_DIGEST_OVERRIDE
                .lock()
                .expect("override lock")
                .is_none(),
            "precondition: no override is installed, so this exercises the table"
        );

        for (name, digest) in ARCHIVE_SHA256_DIGESTS {
            assert_eq!(
                pinned_archive_digest(name).as_deref(),
                Some(*digest),
                "{name} must resolve to its own pinned digest"
            );
        }
        assert!(
            pinned_archive_digest("sherpa-onnx-v0.0.0-nowhere-static-lib.tar.bz2").is_none(),
            "an archive that is not pinned must not resolve to a digest, or \
             download_prebuilt_libs would verify whatever bytes turned up"
        );
    }

    #[test]
    fn the_test_only_digest_override_cannot_reach_a_real_build() {
        // `download_prebuilt_libs` cannot be driven by a synthetic archive without
        // supplying a pinned digest for it, so `pinned_archive_digest` carries a
        // `cfg(test)` override. Cargo never builds a build script under `--test`, so
        // that override is not in the artifact any build runs -- but that is a claim
        // about cargo's behaviour, and this file is exactly where it would fail
        // silently. `scripts/ci/sherpa-build-script-tests.mjs` checks it by
        // compiling both forms and looking for the marker string in each, and it
        // looks for the literal below. Renaming one without the other would leave
        // that check asserting nothing.
        assert_eq!(
            PINNED_DIGEST_OVERRIDE_MARKER, "sherpa-pinned-digest-override-cfg-test-only",
            "the harness scans compiled binaries for this exact literal"
        );
    }

    #[test]
    fn the_pinned_digest_override_is_absent_when_the_file_is_not_built_as_a_test() {
        // Stated as a property of this compilation rather than asserted about the
        // non-test one, because there is no non-test compilation of this file in
        // this process: `cfg(test)` is on, so the override is reachable here and must
        // be reachable only here. The harness supplies the other half by compiling
        // the same file as a plain build script and finding the marker absent.
        let name = wiring_archive_name();
        let installed = PINNED_DIGEST_OVERRIDE
            .lock()
            .expect("override lock")
            .clone()
            .map(|(name, _)| name);
        if installed.is_none() {
            // No wiring test has installed one yet, which is the ordinary case for a
            // test that does not need one.
            assert!(
                pinned_archive_digest(&name).is_some(),
                "precondition: the production pin table is consulted when no override \
                 is installed"
            );
            return;
        }
        assert_eq!(
            installed.as_deref(),
            Some(name.as_str()),
            "the override is installed only for the archive a wiring test built"
        );
    }
}

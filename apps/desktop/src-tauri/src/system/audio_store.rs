use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::fs::{Dir, OpenOptions};
use tauri::Manager;

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

use crate::domain::TranscriptionAudioSnapshot;

const AUDIO_DIR_NAME: &str = "transcription-audio";

fn map_hound_error(err: hound::Error) -> io::Error {
    io::Error::other(err.to_string())
}

/// FNV-1a over the whole id.
///
/// The readable prefix alone cannot keep two ids apart: the prefix exists to
/// keep a filename to one safe component, and everything outside that alphabet
/// is dropped from it, so `a.b` and `ab` — and `""` and `"!!!"` — used to name
/// the same WAV. Hashing the full id means a difference anywhere in it changes
/// the name, so one recording's audio cannot be played back as another's and
/// deleting either transcription cannot remove the other's file.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// The characters a transcription id may be built from for its name to stand
/// on its own. Every id this app mints is a UUID, so this is the normal case.
fn is_self_describing(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'
}

/// How much of a lossy id's readable characters lead the filename. Long enough
/// to recognise a recording in a directory listing, short enough to leave the
/// whole name inside every filesystem's component limit once the digest and the
/// extension are added.
const AUDIO_NAME_STEM_CHARS: usize = 48;

/// One stem that says which transcription it belongs to, and never two.
///
/// The readable characters alone cannot do that. Everything outside
/// `[A-Za-z0-9_-]` is dropped from them, so `a.b` and `ab` — and `"!!!"` and
/// `""` — would name the same WAV, and one recording's audio could then be
/// played back as another's and deleted with it. So the name is the id itself
/// when the id is non-empty and entirely within that alphabet, because that is
/// already unique *and* already the name the file has on disk, and otherwise
/// the readable part followed by the digest of the whole id.
///
/// An empty id is not self-describing even though it has no character outside
/// the alphabet: `chars().all(..)` is vacuously true for it, so the early
/// return would name the recording `.wav` — a hidden file that the read-back
/// path skips — and skip the digest that keeps it apart from every other id.
///
/// The digest is appended after `~`, which the alphabet cannot produce, so the
/// two forms have disjoint name spaces and neither can be written to look like
/// the other.
fn audio_file_stem(transcription_id: &str) -> String {
    if !transcription_id.is_empty() && transcription_id.chars().all(is_self_describing) {
        return transcription_id.to_string();
    }

    let readable: String = transcription_id
        .chars()
        .filter(|ch| is_self_describing(*ch))
        .take(AUDIO_NAME_STEM_CHARS)
        .collect();
    let readable = if readable.is_empty() {
        "transcription"
    } else {
        readable.as_str()
    };

    format!("{readable}~{:016x}", fnv1a_64(transcription_id.as_bytes()))
}

/// Derive the only filename that may represent this transcription's managed
/// snapshot. Database `audio_path` values are descriptive data, never
/// authority to select a file for deletion.
///
/// The name is a safe filename component that no two ids share, and an id that
/// was already safe keeps the name its snapshot was written under, so no
/// existing recording is renamed out from under the transcript it belongs to.
pub(crate) fn audio_file_name_for(transcription_id: &str) -> String {
    format!("{}.wav", audio_file_stem(transcription_id))
}

fn audio_dir_path(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(AUDIO_DIR_NAME);
    Ok(path)
}

fn reject_managed_audio_reparse_point() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Refusing a linked or reparse-point directory on the managed audio path",
    )
}

fn invalid_managed_audio_path(reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("Managed audio path cannot be used: {reason}"),
    )
}

#[cfg(windows)]
fn windows_attributes_include_reparse_point(attributes: u32) -> bool {
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

#[cfg(windows)]
pub(crate) fn is_windows_reparse_point(file: &std::fs::File) -> io::Result<bool> {
    use std::os::windows::fs::MetadataExt;

    Ok(windows_attributes_include_reparse_point(
        file.metadata()?.file_attributes(),
    ))
}

#[cfg(not(windows))]
pub(crate) fn is_windows_reparse_point(_file: &std::fs::File) -> io::Result<bool> {
    Ok(false)
}

/// Turn a just-opened no-follow handle into a plain file handle, after proving
/// on the handle that it is the node the caller is about to use.
///
/// One copy of the sequence, on purpose. The directory walk, the snapshot write
/// and the snapshot read each need the same three answers — not a link, the
/// right kind of node, and on Windows not a reparse point — and a security fix
/// that lands in two of the three call sites is the failure this exists to
/// prevent. `directory` selects which node type counts as a match; `operation`
/// names what the caller is doing so the two rejections stay distinguishable in
/// a log without being written out three times.
fn into_proved_std_file(
    handle: cap_std::fs::File,
    directory: bool,
    operation: &str,
) -> io::Result<std::fs::File> {
    let metadata = handle.metadata()?;
    let node = if directory { "directory" } else { "file" };
    let right_kind = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if metadata.file_type().is_symlink() || !right_kind {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Refusing to {operation} a linked or non-{node} managed audio node"),
        ));
    }

    let handle = handle.into_std();
    if is_windows_reparse_point(&handle)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Refusing to {operation} a Windows reparse-point managed audio node"),
        ));
    }

    Ok(handle)
}

/// Open one directory component below `parent` without following a link.
///
/// `maybe_dir` also makes the Windows handle deny delete sharing, so Windows
/// cannot rename or delete the held directory while a cleanup batch is running.
/// Windows opens a reparse point itself in no-follow mode, so its generic file
/// type can still look like a directory: the native reparse bit has to be read
/// before the handle is turned into a directory capability.
fn open_dir_no_follow(parent: &Dir, name: impl AsRef<Path>) -> io::Result<Dir> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    let child = parent.open_with(name, &options)?;

    Ok(Dir::from_std_file(into_proved_std_file(
        child,
        true,
        "open as a managed audio directory",
    )?))
}

/// Create `name` under `parent` if it is absent, then open it link-free. The
/// post-open check is the one that matters: a component that was replaced with
/// a link between the `create_dir` and the `open` — or one that was already
/// there — is only visible on the handle.
fn create_or_open_dir_no_follow(parent: &Dir, name: impl AsRef<Path>) -> io::Result<Dir> {
    if let Err(err) = parent.create_dir(name.as_ref()) {
        if err.kind() != io::ErrorKind::AlreadyExists {
            return Err(err);
        }
    }

    open_dir_no_follow(parent, name)
}

/// Open `path` as a directory, creating the components that are missing, and
/// refuse to descend through a link at `path` itself or below it.
///
/// A path is only a name until something is opened through it, and both
/// `create_dir_all` and an ambient path open traverse whatever they meet, so a
/// component replaced with a link moves every later read, write and delete to
/// wherever it points. The components from the deepest one that already exists
/// downwards are therefore opened one at a time, no-follow, from a held handle:
/// the missing ones are created by this call so they cannot already be links,
/// and the one that was there has to be a real directory.
///
/// The boundary is `path` itself, the managed root, and it is a boundary
/// because that is the one directory the platform named for this app:
///
/// * A link **at** `path` is refused. No supported platform hands a symlink
///   over as its app-data directory, so following one can only be a
///   substitution of the app's own directory. The guard that used to make this
///   conditional on `missing` being non-empty could not be right in either
///   direction: the same configuration was followed when only the audio
///   directory was missing and refused once that directory existed, so a
///   substituted root worked on the first launch and failed on every one after.
/// * A link **strictly above** `path` is resolved once, because that is the
///   shape the platform itself can hand over — `/var` is one on macOS,
///   `$XDG_DATA_HOME` and `~/.local` routinely are on Linux, and a relocated
///   `~/Library` can be. Refusing those would mean the app cannot create its
///   own audio directory on the machines it ships to, and the refusal buys
///   nothing: a process able to substitute an ancestor of the app-data
///   directory is already able to read and write every recording inside it.
///
/// What this closes: every component at and below the managed root is proved
/// to be a directory on the handle the caller is given, not on a name that was
/// checked earlier, so a component swapped for a link after the check is
/// refused rather than followed.
///
/// What it does not close, deliberately: the prefix above the managed root is
/// resolved once. That is the limit of what a path alone can say — a link the
/// platform put there and an attacker link above a root the attacker
/// pre-created look identical, and telling them apart would need the intended
/// root, which `app_data_dir()` does not carry.
fn open_dir_chain(path: &Path) -> io::Result<Dir> {
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    let existing = loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    if cursor == path {
                        // The managed root itself. Refused whatever is missing
                        // below it.
                        return Err(reject_managed_audio_reparse_point());
                    }
                    // Above the managed root, so it is resolved once and the
                    // walk restarts from the resolved name. Restarting matters:
                    // the components still to be created have to be created
                    // under the resolved root, not re-created through the link
                    // name — creating them by name is what a no-follow open
                    // would refuse, and is where following the link back in.
                    // `canonicalize` returns a name with no link left in it, so
                    // the restarted walk lands on a real directory, and each
                    // restart strictly shortens the path, so this terminates.
                    let mut reanchored = fs::canonicalize(cursor)?;
                    for name in missing.iter().rev() {
                        reanchored.push(name);
                    }
                    return open_dir_chain(&reanchored);
                }
                if !metadata.is_dir() {
                    return Err(invalid_managed_audio_path(&format!(
                        "{} is not a directory",
                        cursor.to_string_lossy()
                    )));
                }
                break cursor;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| invalid_managed_audio_path("it has no name to create"))?;
                missing.push(name);
                cursor = cursor.parent().ok_or_else(|| {
                    invalid_managed_audio_path("it has no parent directory to create it under")
                })?;
            }
            Err(err) => return Err(err),
        }
    };

    let mut handle = open_checked_component(existing)?;
    for name in missing.into_iter().rev() {
        handle = create_or_open_dir_no_follow(&handle, name)?;
    }

    Ok(handle)
}

/// Open the deepest component that already exists, so the handle returned is
/// the directory that was checked rather than a second resolution of its name.
///
/// `canonicalize(existing)` would resolve that component again: a component
/// replaced with a link between the check and the resolve is followed, and the
/// resolved directory is the link's target rather than the one that was
/// examined. Only the prefix *above* it is canonicalized — the residual the
/// caller documents — and the component itself is then opened no-follow from
/// that handle, so the check and the open see the same directory.
fn open_checked_component(existing: &Path) -> io::Result<Dir> {
    let Some(parent_path) = existing.parent() else {
        // A filesystem root has no parent to descend from and nothing above it
        // to resolve. The walk in `open_dir_chain` has already refused it if it
        // was a link.
        return Dir::open_ambient_dir(&fs::canonicalize(existing)?, cap_std::ambient_authority());
    };
    let Some(name) = existing.file_name() else {
        return Err(invalid_managed_audio_path("it has no name to open"));
    };
    // `parent` of a one-component relative path is empty, which names the
    // working directory rather than nothing at all.
    let parent_source = if parent_path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent_path
    };

    let parent = Dir::open_ambient_dir(
        &fs::canonicalize(parent_source)?,
        cap_std::ambient_authority(),
    )?;

    open_dir_no_follow(&parent, name)
}

/// Open the managed directory as a capability, rather than resolving its path
/// and using that path later. The held handle stays bound to the directory that
/// was checked even if another process replaces its name. `maybe_dir` also
/// makes the Windows handle deny delete sharing, so Windows cannot rename or
/// delete the held directory while a cleanup batch is running.
fn open_managed_audio_dir_at(app_data_dir: &Path) -> io::Result<Dir> {
    let app_data = open_dir_chain(app_data_dir)?;

    create_or_open_dir_no_follow(&app_data, AUDIO_DIR_NAME)
}

pub(crate) fn open_managed_audio_dir(app: &tauri::AppHandle) -> io::Result<Dir> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    open_managed_audio_dir_at(&app_data_dir)
}

#[cfg(test)]
pub(crate) fn open_managed_audio_dir_for_test(app_data_dir: &Path) -> io::Result<Dir> {
    open_managed_audio_dir_at(app_data_dir)
}

pub fn audio_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    // Preserve the existing path-returning API for non-destructive callers,
    // while refusing a linked managed root at the time it is obtained.
    let _managed_directory = open_managed_audio_dir(app)?;
    audio_dir_path(app)
}

pub fn audio_path_for(app: &tauri::AppHandle, transcription_id: &str) -> io::Result<PathBuf> {
    let mut path = audio_dir(app)?;
    path.push(audio_file_name_for(transcription_id));
    Ok(path)
}

pub fn save_transcription_audio(
    app: &tauri::AppHandle,
    transcription_id: &str,
    samples: &[f32],
    sample_rate: u32,
) -> io::Result<TranscriptionAudioSnapshot> {
    if samples.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cannot persist empty audio buffer",
        ));
    }

    if sample_rate == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Audio sample rate must be greater than zero",
        ));
    }

    let file_name = audio_file_name_for(transcription_id);
    let mut path = audio_dir_path(app)?;
    path.push(&file_name);
    let managed_directory = open_managed_audio_dir(app)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .follow(FollowSymlinks::No);
    let audio_file = managed_directory.open_with(&file_name, &options)?;
    // Truncate through the opened handle only after proving it is a regular
    // file. This prevents Windows' reparse-point semantics from turning a
    // no-follow open into a destructive overwrite.
    let audio_file = into_proved_std_file(audio_file, false, "overwrite")?;
    audio_file.set_len(0)?;
    let mut writer = WavWriter::new(
        audio_file,
        WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    )
    .map_err(map_hound_error)?;
    for sample in samples {
        let normalized = sample.clamp(-1.0, 1.0);
        let quantized = (normalized * i16::MAX as f32).round() as i16;
        writer.write_sample(quantized).map_err(map_hound_error)?;
    }
    writer.finalize().map_err(map_hound_error)?;

    let duration_ms = ((samples.len() as f64 / sample_rate as f64) * 1_000.0).round() as i64;

    Ok(TranscriptionAudioSnapshot {
        file_path: path.to_string_lossy().to_string(),
        duration_ms,
    })
}

/// Remove one derived managed filename through a directory capability. The
/// name is one sanitized component, so a persisted path cannot traverse or
/// redirect this operation. `Dir::remove_file` resolves relative to the held
/// handle; on Windows cap-std prevents replacement of that held root.
pub(crate) fn delete_audio_file(audio_dir: &Dir, transcription_id: &str) -> io::Result<()> {
    audio_dir.remove_file(Path::new(&audio_file_name_for(transcription_id)))
}

pub(crate) fn delete_audio_file_named(
    audio_dir: &Dir,
    file_name: &std::ffi::OsStr,
) -> io::Result<()> {
    audio_dir.remove_file(Path::new(file_name))
}

/// Open the snapshot named by `transcription_id` from a held managed
/// directory. As with deletion, the persisted path is never used to choose a
/// file. No-follow plus the post-open check rejects links and Windows reparse
/// points before the standard file handle is returned to a reader.
pub(crate) fn open_audio_file_for_read(
    audio_dir: &Dir,
    transcription_id: &str,
) -> io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let audio_file = audio_dir.open_with(audio_file_name_for(transcription_id), &options)?;
    into_proved_std_file(audio_file, false, "read")
}

pub fn load_audio_samples(file: &mut std::fs::File) -> io::Result<(Vec<f32>, u32)> {
    let mut reader = WavReader::new(file).map_err(map_hound_error)?;
    let spec = reader.spec();

    if spec.sample_rate == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file missing sample rate",
        ));
    }

    if spec.channels == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file missing channel information",
        ));
    }

    let channels = spec.channels as usize;
    let capacity = reader.duration() as usize / channels.max(1);
    let mut samples = Vec::with_capacity(capacity);

    match spec.sample_format {
        SampleFormat::Float => {
            if channels == 1 {
                for sample in reader.samples::<f32>() {
                    let value = sample.map_err(|err| {
                        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
                    })?;
                    if value.is_finite() {
                        samples.push(value);
                    }
                }
            } else {
                let mut frame = Vec::with_capacity(channels);
                let mut iter = reader.samples::<f32>();

                loop {
                    frame.clear();
                    for _ in 0..channels {
                        match iter.next() {
                            Some(Ok(value)) => frame.push(value),
                            Some(Err(err)) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    err.to_string(),
                                ));
                            }
                            None => {
                                if frame.is_empty() {
                                    break;
                                } else {
                                    return Err(io::Error::new(
                                        io::ErrorKind::UnexpectedEof,
                                        "Audio frame truncated",
                                    ));
                                }
                            }
                        }
                    }

                    if frame.is_empty() {
                        break;
                    }

                    let mut sum = 0.0f32;
                    let mut count = 0usize;
                    for value in &frame {
                        if value.is_finite() {
                            sum += *value;
                            count += 1;
                        }
                    }

                    if count > 0 {
                        samples.push(sum / count as f32);
                    }
                }
            }
        }
        SampleFormat::Int => {
            if spec.bits_per_sample != 16 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Unsupported PCM bit depth: {}", spec.bits_per_sample),
                ));
            }

            let scale = i16::MAX as f32;

            if channels == 1 {
                for sample in reader.samples::<i16>() {
                    let value = sample.map_err(|err| {
                        io::Error::new(io::ErrorKind::InvalidData, err.to_string())
                    })? as f32
                        / scale;
                    samples.push(value.clamp(-1.0, 1.0));
                }
            } else {
                let mut frame = Vec::with_capacity(channels);
                let mut iter = reader.samples::<i16>();

                loop {
                    frame.clear();
                    for _ in 0..channels {
                        match iter.next() {
                            Some(Ok(value)) => frame.push(value),
                            Some(Err(err)) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::InvalidData,
                                    err.to_string(),
                                ));
                            }
                            None => {
                                if frame.is_empty() {
                                    break;
                                } else {
                                    return Err(io::Error::new(
                                        io::ErrorKind::UnexpectedEof,
                                        "Audio frame truncated",
                                    ));
                                }
                            }
                        }
                    }

                    if frame.is_empty() {
                        break;
                    }

                    let mut sum = 0.0f32;
                    let mut count = 0usize;

                    for value in &frame {
                        sum += (*value as f32) / scale;
                        count += 1;
                    }

                    if count > 0 {
                        samples.push((sum / count as f32).clamp(-1.0, 1.0));
                    }
                }
            }
        }
    }

    if samples.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Audio file did not contain usable samples",
        ));
    }

    Ok((samples, spec.sample_rate))
}

#[cfg(test)]
mod tests {
    // `open_checked_component` is imported by the test that uses it rather than
    // here: every test that touches it is `#[cfg(unix)]`, so a module-level
    // import is dead code on Windows and that lint job runs with `-D warnings`.
    use super::{
        audio_file_name_for, delete_audio_file, into_proved_std_file, open_audio_file_for_read,
        open_managed_audio_dir_at, AUDIO_DIR_NAME,
    };
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
    use cap_std::fs::{Dir, OpenOptions};
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TemporaryDirectory(PathBuf);

    impl TemporaryDirectory {
        fn create() -> Self {
            static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
            let id = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mausvoice-audio-store-test-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test temporary directory must be creatable");
            Self(path)
        }

        fn audio_dir(&self) -> PathBuf {
            self.0.join(AUDIO_DIR_NAME)
        }
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn generated_audio_filename_is_one_sanitized_component() {
        // The name is one filename component and nothing else: the id is data
        // from the database, and the managed directory handle is the only thing
        // that decides which file a read or a delete touches.
        for id in [
            "session-42",
            "../../outside",
            "..",
            "/etc/passwd",
            "a\\b",
            "",
            "!!!",
            "a.b",
        ] {
            let name = audio_file_name_for(id);
            assert!(!name.contains('/'), "{id:?} produced a separator: {name}");
            assert!(!name.contains('\\'), "{id:?} produced a separator: {name}");
            assert!(
                !name.contains(".."),
                "{id:?} produced a parent reference: {name}"
            );
            assert!(name.ends_with(".wav"), "{id:?} produced {name}");
        }
    }

    #[test]
    fn the_readable_part_of_the_id_leads_the_name_in_both_forms() {
        // Whichever form the name takes, the part a person recognises in a
        // directory listing comes first.
        assert!(
            audio_file_name_for("session-42").starts_with("session-42"),
            "a self-describing id is its own readable part"
        );
        let hashed = audio_file_name_for("../../session-42");
        assert!(
            hashed.starts_with("session-42"),
            "a lossy id's readable part must lead its name: {hashed}"
        );
    }

    /// An id made only of `[A-Za-z0-9_-]` is already its own unique name — that
    /// covers every UUID this app mints — so adding a digest of it renames a
    /// recording for nothing and leaves the file it already has on disk
    /// unreachable by id. The readable prefix is the whole name here.
    #[test]
    fn a_self_describing_id_keeps_the_name_its_snapshot_already_has() {
        assert_eq!(
            audio_file_name_for("session-42"),
            "session-42.wav",
            "an unambiguous id must not be renamed"
        );
        assert_eq!(
            audio_file_name_for("3f2a9c1e-4b7d-4e6f-8a1c-9d0e2f3a4b5c"),
            "3f2a9c1e-4b7d-4e6f-8a1c-9d0e2f3a4b5c.wav",
            "a UUID id must keep the filename its snapshot was written under"
        );
    }

    /// The two cases cannot land on each other's names: the hashed form always
    /// carries the separator, and a self-describing id cannot produce one.
    #[test]
    fn a_hashed_name_cannot_be_mistaken_for_a_self_describing_one() {
        let separator = '~';
        let hashed = audio_file_name_for("a.b");
        assert!(
            hashed.contains(separator),
            "a lossy id's name must carry the separator: {hashed}"
        );
        for id in ["session-42", "a", "A_1-2", "3f2a9c1e-4b7d"] {
            assert!(
                !audio_file_name_for(id).contains(separator),
                "{id:?} is self-describing and must not take the hashed form"
            );
        }
    }

    /// `sanitize_id` used to keep only `[A-Za-z0-9_-]` and drop everything
    /// else, so two different transcription ids could name the same WAV. The
    /// recording saved under one was then playable as the other's, and
    /// deleting either transcription deleted the other's file.
    ///
    /// The colliding pairs are found by brute force over a short alphabet
    /// rather than hard-coded, so the test keeps describing the property
    /// instead of one example of it.
    #[test]
    fn ids_that_differ_only_in_dropped_characters_do_not_share_a_file() {
        const ALPHABET: [char; 5] = ['a', 'b', '.', '/', '-'];
        let mut ids: Vec<String> = vec![String::new()];
        for first in ALPHABET {
            ids.push(first.to_string());
            for second in ALPHABET {
                ids.push(format!("{first}{second}"));
            }
        }

        for (index, left) in ids.iter().enumerate() {
            for right in ids.iter().skip(index + 1) {
                assert_ne!(
                    audio_file_name_for(left),
                    audio_file_name_for(right),
                    "{left:?} and {right:?} must not share a managed audio file"
                );
            }
        }
    }

    /// The ids this app mints are UUIDs, so the derivation has to agree with
    /// the sanitizer that named every recording before it, or an upgrade would
    /// orphan the files it already wrote. `pre_upgrade_sanitize_id` is that
    /// sanitizer, copied from the version this replaced, and the check runs
    /// over the shapes a stored id can have rather than over one example: the
    /// two agree only because every character of a UUID survives the old filter
    /// *and* the whole of it is inside the self-describing alphabet.
    #[test]
    fn a_minted_id_keeps_the_name_the_pre_upgrade_sanitizer_gave_it() {
        fn pre_upgrade_sanitize_id(id: &str) -> String {
            let mut sanitized = id
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
                .collect::<String>();
            if sanitized.is_empty() {
                sanitized = "transcription".to_string();
            }
            sanitized
        }

        for id in [
            "3f2a9c1e-4b7d-4e6f-8a1c-9d0e2f3a4b5c",
            "00000000-0000-4000-8000-000000000000",
            "ffffffff-ffff-4fff-bfff-ffffffffffff",
            // Upper case, which `crypto.randomUUID` never produces but a
            // restored backup or an id typed in by hand can be.
            "3F2A9C1E-4B7D-4E6F-8A1C-9D0E2F3A4B5C",
            // Short ids, which the old sanitizer also passed through untouched.
            "1",
            "42",
        ] {
            assert_eq!(
                audio_file_name_for(id),
                format!("{}.wav", pre_upgrade_sanitize_id(id)),
                "{id:?} must resolve to the file an earlier build already wrote for it"
            );
        }
    }

    /// `chars().all(..)` is vacuously true for an empty id, so the
    /// self-describing early return used to name that recording `.wav` — a
    /// hidden file — and skip the digest that keeps it apart from every other
    /// id. The empty id is the one id the readable alphabet says nothing
    /// about, so it has to take the hashed form like any other lossy id.
    #[test]
    fn an_empty_id_takes_the_hashed_form_rather_than_naming_a_hidden_file() {
        let name = audio_file_name_for("");
        assert_ne!(
            name, ".wav",
            "an empty id must not take the self-describing early return"
        );
        assert!(
            !name.starts_with('.'),
            "an empty id must not produce a hidden filename: {name}"
        );
        assert!(
            name.contains('~'),
            "an empty id has no readable characters, so it needs the digest: {name}"
        );
        assert_ne!(
            audio_file_name_for(""),
            audio_file_name_for("!!!"),
            "the empty id and a lossy id differ only in dropped characters, so the digest is what keeps them apart"
        );
    }

    /// The directory walk, the snapshot write and the snapshot read all refuse
    /// the same three things, through one function so a fix cannot land in two
    /// of them. What is pinned here is that the shared function still refuses
    /// each of them: deleting a branch from `into_proved_std_file` makes the
    /// matching assertion below fail. The Windows reparse bit is the fourth
    /// branch and cannot be reached from this host, so it is pinned on Windows
    /// by `windows_reparse_attributes_are_detected`.
    mod shared_validation {
        use super::*;

        /// Open `name` through `dir` the way every call site does: no-follow,
        /// so the handle names the link itself rather than its target.
        ///
        /// `maybe_dir` because two of the fixtures below are directories, which
        /// is why `open_dir_no_follow` sets it on the production side. It is
        /// inert on Unix — cap-primitives' rustix path builds the open flags in
        /// `compute_oflags`, which never reads `maybe_dir` — and on Windows it
        /// is what adds `FILE_FLAG_BACKUP_SEMANTICS`, without which
        /// `CreateFileW` refuses a directory outright. No job runs these tests
        /// on Windows (`rust-windows-gated` lints `--all-targets`, which
        /// compiles them without executing them), so without the flag the two
        /// directory fixtures would fail for whoever runs `cargo test` there,
        /// on a helper rather than on the code under test.
        fn open_no_follow(dir: &Dir, name: &str) -> io::Result<cap_std::fs::File> {
            let mut options = OpenOptions::new();
            options
                .read(true)
                .follow(FollowSymlinks::No)
                .maybe_dir(true);
            dir.open_with(name, &options)
        }

        fn opened(dir: &Dir, name: &str) -> cap_std::fs::File {
            open_no_follow(dir, name)
                .unwrap_or_else(|err| panic!("{name} must be openable for the fixture: {err}"))
        }

        fn held_dir(root: &PathBuf) -> Dir {
            Dir::open_ambient_dir(root, cap_std::ambient_authority())
                .expect("the temporary directory must be openable as a capability")
        }

        /// On Unix a link is refused by the *open*, not by the metadata check:
        /// `O_NOFOLLOW` answers `ELOOP` for a link, so `open_with` never returns
        /// a handle to one and `into_proved_std_file` is never reached. That is
        /// what makes the whole scheme work here, so it is pinned — and it is
        /// why the link branch inside the shared function cannot be exercised
        /// from this host. It is load-bearing on Windows, where a reparse point
        /// opens successfully in no-follow mode and its generic file type can
        /// still look like a directory; that branch is pinned there by
        /// `windows_reparse_attributes_are_detected`.
        #[cfg(unix)]
        #[test]
        fn a_link_is_refused_by_the_open_itself_on_unix() {
            use std::os::unix::fs::symlink;

            let root = TemporaryDirectory::create();
            fs::write(root.0.join("secret.wav"), b"do not read").expect("fixture must be writable");
            // A *relative* target, so the link resolves inside the directory
            // that is held and the refusal below can only be the no-follow open.
            // An absolute one is refused by the capability's own sandbox before
            // the flag is ever consulted — cap-primitives opens through
            // `openat2(RESOLVE_BENEATH)`, which answers `EXDEV` for a target
            // outside the root, and `EXDEV` is reported as "a path led outside
            // of the filesystem" — and then this assertion would hold for any
            // open at all.
            symlink("secret.wav", root.0.join("linked.wav")).expect("link must be creatable");
            let dir = held_dir(&root.0);

            let opened = open_no_follow(&dir, "linked.wav");
            assert!(
                opened.is_err(),
                "a no-follow open must not hand back a handle to a link: {opened:?}"
            );

            // The read call site refuses for the same reason, but it looks
            // somewhere else: `open_audio_file_for_read` resolves the derived
            // name *inside the managed audio directory*, and the link above is
            // one level above that. With only the link above, the call fails
            // `NotFound` whatever the open does, and the assertion below would
            // pass on a read path carrying no guard at all. The decoy it points
            // at is inside the managed directory too, for the same
            // `RESOLVE_BENEATH` reason as above.
            let held_audio_dir = open_managed_audio_dir_at(&root.0).expect("managed dir");
            fs::write(root.audio_dir().join("decoy.wav"), b"another recording")
                .expect("fixture must be writable");
            symlink(
                "decoy.wav",
                root.audio_dir().join(audio_file_name_for("linked")),
            )
            .expect("link inside the managed directory must be creatable");

            assert!(
                open_audio_file_for_read(&held_audio_dir, "linked").is_err(),
                "a link under the name the read path derives must be refused \
                 where the read path looks, not merely be absent from it"
            );
        }

        #[test]
        fn the_wrong_kind_of_node_is_refused() {
            let root = TemporaryDirectory::create();
            fs::create_dir(root.0.join("a-directory")).expect("fixture must be creatable");
            fs::write(root.0.join("a-file"), b"bytes").expect("fixture must be writable");
            let dir = held_dir(&root.0);

            assert!(
                into_proved_std_file(opened(&dir, "a-directory"), false, "test").is_err(),
                "a directory opened where a file is wanted must be refused"
            );
            assert!(
                into_proved_std_file(opened(&dir, "a-file"), true, "test").is_err(),
                "a file opened where a directory is wanted must be refused"
            );
        }

        /// The positive control, so the rejections above cannot be satisfied by
        /// a helper that refuses everything: the ordinary shapes still come
        /// through, and each comes back as the node that was opened.
        #[test]
        fn a_regular_node_of_the_requested_kind_is_accepted() {
            let root = TemporaryDirectory::create();
            fs::create_dir(root.0.join("a-directory")).expect("fixture must be creatable");
            fs::write(root.0.join("a-file"), b"bytes").expect("fixture must be writable");
            let dir = held_dir(&root.0);

            let file = into_proved_std_file(opened(&dir, "a-file"), false, "test")
                .expect("a regular file asked for as a file must be accepted");
            assert!(file.metadata().expect("metadata").is_file());
            let directory = into_proved_std_file(opened(&dir, "a-directory"), true, "test")
                .expect("a regular directory asked for as a directory must be accepted");
            assert!(directory.metadata().expect("metadata").is_dir());
        }
    }

    /// A link above the managed root, with the whole subtree below it still to
    /// be created. This is the first run, and it is the only shape in which the
    /// link is ever seen by the walk: `symlink_metadata` resolves every
    /// component except the last, so as soon as anything below the link exists
    /// the walk never reaches the link as a component of its own.
    ///
    /// It failed here. The walk refused the link because refusing *every* link
    /// it met was the rule, which meant a symlinked `$XDG_DATA_HOME`, a
    /// dotfile-managed `~/.local` and a relocated `~/Library` could create the
    /// managed audio directory on no launch at all — and, because the refusal
    /// did not depend on what was missing, the same layout started working the
    /// moment a later launch created the child. Refusing the managed root and
    /// resolving what is above it is one rule rather than two, and this is the
    /// half of it that had no coverage at all.
    #[cfg(unix)]
    #[test]
    fn a_link_above_a_managed_root_that_does_not_exist_yet_is_resolved_rather_than_refused() {
        use std::os::unix::fs::symlink;

        let base = TemporaryDirectory::create();
        let outside = base.0.join("linked-home");
        fs::create_dir(&outside).expect("the link target must be creatable");
        symlink(&outside, base.0.join("home")).expect("the home link must be creatable");
        // Nothing below the link exists yet: this is the first run.
        let app_data_dir = base.0.join("home").join("app-data");

        let held = open_managed_audio_dir_at(&app_data_dir).expect(
            "a link above a managed root that does not exist yet is the platform's own shape, \
             not a substitution of it",
        );

        assert!(held.dir_metadata().expect("held metadata").is_dir());
        assert!(
            outside.join("app-data").join(AUDIO_DIR_NAME).is_dir(),
            "the subtree the walk had to create belongs under the resolved root, not under \
             the link name and not beside it"
        );
        assert!(
            !base.0.join("app-data").exists(),
            "the resolved link target is the only place the managed directory may be created"
        );
    }

    /// The managed root the platform hands over is normally already there, so
    /// there is nothing to create and nothing missing below it. That is the
    /// case where an `app_data_dir` that *is* a link used to be let through:
    /// the guard that refuses a linked component was only reached once at least
    /// one component below it was missing, and a fully existing root skipped
    /// it entirely. `canonicalize` then resolved the link and the managed audio
    /// directory was created inside whatever it pointed at.
    #[cfg(unix)]
    #[test]
    fn an_existing_managed_root_that_is_a_link_is_refused() {
        use std::os::unix::fs::symlink;

        let base = TemporaryDirectory::create();
        let outside = base.0.join("outside-root");
        fs::create_dir(&outside).expect("the link target must be creatable");
        let app_data_dir = base.0.join("redirected");
        symlink(&outside, &app_data_dir).expect("the redirect link must be creatable");

        assert!(
            open_managed_audio_dir_at(&app_data_dir).is_err(),
            "an existing managed root reached through a link must be refused, not followed"
        );
        assert!(
            !outside.join(AUDIO_DIR_NAME).exists(),
            "a refused root must not create anything in the directory it pointed at"
        );
    }

    /// Reached with a link directly, only the no-follow open can refuse it:
    /// `canonicalize` resolves the component it is given, so a component that
    /// was swapped for a link between the walk checking it and the code opening
    /// it would be handed back as its target. That is the window the walk's
    /// own guard cannot close, because the swap happens after the guard has
    /// already said the component was a directory.
    #[cfg(unix)]
    #[test]
    fn the_checked_component_is_opened_link_free_rather_than_canonicalized() {
        use super::open_checked_component;
        use std::os::unix::fs::symlink;

        let base = TemporaryDirectory::create();
        let outside = base.0.join("outside-root");
        fs::create_dir(&outside).expect("the link target must be creatable");
        let linked = base.0.join("redirected");
        symlink(&outside, &linked).expect("the redirect link must be creatable");
        assert!(
            fs::metadata(&linked)
                .expect("a link to a directory still resolves")
                .is_dir(),
            "the link is valid, so a refusal is about not following it rather than it being broken"
        );

        assert!(
            open_checked_component(&linked).is_err(),
            "the component that was checked has to be opened, not resolved to a second name"
        );
    }

    /// The residual `open_dir_chain` accepts on purpose, pinned here so it
    /// cannot be tightened by accident: only the managed root itself and what is
    /// below it are required not to be a link. A link *above* the managed root is
    /// resolved, because `/var` is one on macOS, a symlinked `$XDG_DATA_HOME` and
    /// `~/.local` routinely are on Linux, and a user's home directory can be one
    /// anywhere — refusing those would mean the app could not open its own
    /// directory on the platforms it ships to.
    ///
    /// This is the already-exists shape, where the walk resolves the prefix and
    /// finds a real component on its first probe. The first-run shape, where the
    /// walk has to resolve the link itself and then create the subtree, is
    /// `a_link_above_a_managed_root_that_does_not_exist_yet_is_resolved_rather_than_refused`.
    #[cfg(unix)]
    #[test]
    fn a_link_above_the_managed_root_is_resolved_rather_than_refused() {
        use std::os::unix::fs::symlink;

        let base = TemporaryDirectory::create();
        let home = base.0.join("real-home");
        fs::create_dir(&home).expect("the home directory must be creatable");
        fs::create_dir(home.join("app-data")).expect("the app-data directory must be creatable");
        symlink(&home, base.0.join("home")).expect("the home link must be creatable");
        let app_data_dir = base.0.join("home").join("app-data");

        let held = open_managed_audio_dir_at(&app_data_dir).expect(
            "a link above the managed root is the platform's own shape, not a redirect of it",
        );

        assert!(held.dir_metadata().expect("held metadata").is_dir());
        assert!(
            home.join("app-data").join(AUDIO_DIR_NAME).is_dir(),
            "the managed directory belongs beside the resolved app-data directory, not beside its link"
        );
    }

    /// The plain shape: several components are missing and every one of them is
    /// created. There is no link anywhere in this chain, so the name says what
    /// the test asserts — that the walk creates a missing root one component at a
    /// time rather than handing `create_dir_all` the whole path.
    ///
    /// The chain-with-a-link shapes are the two tests above, one per side of the
    /// boundary: a link above the managed root is resolved, and a link at the
    /// managed root is refused.
    #[test]
    fn a_missing_root_chain_is_created_one_component_at_a_time() {
        let base = TemporaryDirectory::create();
        let app_data_dir = base.0.join("a").join("b").join("c");

        let held = open_managed_audio_dir_at(&app_data_dir)
            .expect("a root that does not exist yet must still be creatable");

        for created in ["a", "a/b", "a/b/c", "a/b/c/transcription-audio"] {
            assert!(
                base.0.join(created).is_dir(),
                "{created} must have been created as a real directory"
            );
        }
        assert!(
            held.dir_metadata().expect("held metadata").is_dir(),
            "the managed capability must be the directory that was created"
        );
    }

    #[test]
    fn opens_a_regular_managed_audio_directory() {
        let root = TemporaryDirectory::create();
        let held_audio_dir =
            open_managed_audio_dir_at(&root.0).expect("managed audio directory must be openable");

        assert!(
            held_audio_dir
                .dir_metadata()
                .expect("held managed directory metadata must be available")
                .is_dir(),
            "the managed capability must be a directory"
        );
    }

    #[test]
    fn deletion_uses_the_transcription_id_not_a_tampered_stored_path() {
        let root = TemporaryDirectory::create();
        let held_audio_dir =
            open_managed_audio_dir_at(&root.0).expect("managed audio directory must be openable");
        let expected = root.audio_dir().join(audio_file_name_for("known-id"));
        let outside = root.0.join("outside.wav");
        fs::write(&expected, b"managed").expect("managed fixture must be writable");
        fs::write(&outside, b"do not delete").expect("outside fixture must be writable");

        // A mutable `audio_path` could claim `outside.wav`; cleanup has no API
        // that accepts it, and instead derives the filename from the ID.
        delete_audio_file(&held_audio_dir, "known-id")
            .expect("derived managed file must be removable");

        assert!(
            !expected.exists(),
            "the derived managed file must be removed"
        );
        assert!(
            outside.exists(),
            "a tampered stored path must remain untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn held_directory_deletion_survives_root_replacement() {
        let root = TemporaryDirectory::create();
        let held_audio_dir =
            open_managed_audio_dir_at(&root.0).expect("managed audio directory must be openable");
        let original = root.audio_dir();
        let detached = root.0.join("former-transcription-audio");
        let file_name = audio_file_name_for("session");
        fs::write(original.join(&file_name), b"delete this")
            .expect("original fixture must be writable");

        // Simulate an attacker replacing the managed directory's *path* after
        // cleanup opened it. On Unix the open capability still names the
        // original directory, so removal must not touch the replacement.
        fs::rename(&original, &detached).expect("open Unix directories can be renamed");
        fs::create_dir(&original).expect("replacement directory must be creatable");
        let replacement_file = original.join(&file_name);
        fs::write(&replacement_file, b"do not delete")
            .expect("replacement fixture must be writable");

        delete_audio_file(&held_audio_dir, "session")
            .expect("held-directory deletion must remove the original entry");

        assert!(
            !detached.join(&file_name).exists(),
            "the original held directory entry must be removed"
        );
        assert!(
            replacement_file.exists(),
            "the replacement directory entry must remain untouched"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_attributes_are_detected() {
        use super::windows_attributes_include_reparse_point;
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        assert!(windows_attributes_include_reparse_point(
            FILE_ATTRIBUTE_REPARSE_POINT.0
        ));
        assert!(!windows_attributes_include_reparse_point(0));
    }

    #[cfg(unix)]
    #[test]
    fn managed_root_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = TemporaryDirectory::create();
        let target = root.0.join("other-directory");
        fs::create_dir(&target).expect("symlink target must be creatable");
        symlink(&target, root.audio_dir()).expect("managed-root symlink must be creatable");

        assert!(
            open_managed_audio_dir_at(&root.0).is_err(),
            "a linked managed root must never become a deletion capability"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_a_final_symlink() {
        use std::os::unix::fs::symlink;

        let root = TemporaryDirectory::create();
        let held_audio_dir =
            open_managed_audio_dir_at(&root.0).expect("managed audio directory must be openable");
        let secret = root.0.join("secret.wav");
        fs::write(&secret, b"do not read").expect("secret fixture must be writable");
        symlink(
            &secret,
            root.audio_dir().join(audio_file_name_for("session")),
        )
        .expect("final symlink must be creatable");

        assert!(
            open_audio_file_for_read(&held_audio_dir, "session").is_err(),
            "a final symlink must not be opened for audio reads"
        );
    }

    #[test]
    fn read_returns_a_handle_for_the_derived_regular_file() {
        let root = TemporaryDirectory::create();
        let held_audio_dir =
            open_managed_audio_dir_at(&root.0).expect("managed audio directory must be openable");
        let expected = root.audio_dir().join(audio_file_name_for("session"));
        fs::write(&expected, b"readable-bytes").expect("fixture must be writable");

        let mut file = open_audio_file_for_read(&held_audio_dir, "session")
            .expect("derived regular file must be readable");
        let mut contents = String::new();
        use std::io::Read;
        file.read_to_string(&mut contents)
            .expect("fixture must be readable through returned handle");
        assert_eq!(contents, "readable-bytes");
    }
}

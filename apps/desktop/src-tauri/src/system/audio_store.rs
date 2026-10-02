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
/// `[A-Za-z0-9_-]` is dropped from them, so `a.b` and `ab` — and `""` and
/// `"!!!"` — would name the same WAV, and one recording's audio could then be
/// played back as another's and deleted with it. So the name is the id itself
/// when the id is entirely within that alphabet, because that is already unique
/// *and* already the name the file has on disk, and otherwise the readable part
/// followed by the digest of the whole id.
///
/// The digest is appended after `~`, which the alphabet cannot produce, so the
/// two forms have disjoint name spaces and neither can be written to look like
/// the other.
fn audio_file_stem(transcription_id: &str) -> String {
    if transcription_id.chars().all(is_self_describing) {
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
    let metadata = child.metadata()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(reject_managed_audio_reparse_point());
    }
    let child = child.into_std();
    if is_windows_reparse_point(&child)? {
        return Err(reject_managed_audio_reparse_point());
    }

    Ok(Dir::from_std_file(child))
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
/// refuse to descend through a link anywhere in it.
///
/// A path is only a name until something is opened through it, and both
/// `create_dir_all` and an ambient path open traverse whatever they meet, so a
/// component replaced with a link moves every later read, write and delete to
/// wherever it points. The components from the deepest one that already exists
/// downwards are therefore opened one at a time, no-follow, from a held handle:
/// the missing ones are created by this call so they cannot already be links,
/// and the ones that were there have to be real directories.
///
/// Everything *above* that point is resolved once, because the app-data path
/// the platform hands over may legitimately sit under a link — `/var` is one on
/// macOS, and a user's home directory can be one. That is the limit of what a
/// path alone can say: a link above the root and an attacker link above a root
/// the attacker pre-created look identical, and telling them apart would need
/// the intended root, which `app_data_dir()` does not carry.
fn open_dir_chain(path: &Path) -> io::Result<Dir> {
    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    let base = loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() && !missing.is_empty() {
                    return Err(reject_managed_audio_reparse_point());
                }
                if !metadata.is_dir() && !metadata.file_type().is_symlink() {
                    return Err(invalid_managed_audio_path(&format!(
                        "{} is not a directory",
                        cursor.to_string_lossy()
                    )));
                }
                break fs::canonicalize(cursor)?;
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
    if !fs::metadata(&base)?.is_dir() {
        return Err(invalid_managed_audio_path(&format!(
            "{} does not name a directory",
            base.to_string_lossy()
        )));
    }

    let mut handle = Dir::open_ambient_dir(&base, cap_std::ambient_authority())?;
    for name in missing.into_iter().rev() {
        handle = create_or_open_dir_no_follow(&handle, name)?;
    }

    Ok(handle)
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
    let metadata = audio_file.metadata()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to overwrite a linked or non-file audio snapshot",
        ));
    }
    let audio_file = audio_file.into_std();
    if is_windows_reparse_point(&audio_file)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to overwrite a Windows reparse-point audio snapshot",
        ));
    }
    // Truncate through the opened handle only after proving it is a regular
    // file. This prevents Windows' reparse-point semantics from turning a
    // no-follow open into a destructive overwrite.
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
    let metadata = audio_file.metadata()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to read a linked or non-file audio snapshot",
        ));
    }
    let audio_file = audio_file.into_std();
    if is_windows_reparse_point(&audio_file)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to read a Windows reparse-point audio snapshot",
        ));
    }

    Ok(audio_file)
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
    use super::{
        audio_file_name_for, delete_audio_file, open_audio_file_for_read,
        open_managed_audio_dir_at, AUDIO_DIR_NAME,
    };
    use std::fs;
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

    /// A path is only a name until something is opened through it. The managed
    /// root used to be built with `create_dir_all` and then opened by name, and
    /// both traverse whatever they meet, so a replaced component moved every
    /// later read, write and delete to wherever the link pointed.
    #[cfg(unix)]
    #[test]
    fn a_link_in_the_managed_root_path_is_refused_rather_than_followed() {
        use std::os::unix::fs::symlink;

        let base = TemporaryDirectory::create();
        let outside = base.0.join("outside-root");
        fs::create_dir(&outside).expect("the link target must be creatable");
        symlink(&outside, base.0.join("redirected")).expect("the redirect link must be creatable");
        let app_data_dir = base.0.join("redirected").join("app-data");

        assert!(
            open_managed_audio_dir_at(&app_data_dir).is_err(),
            "a managed root reached through a link must be refused, not followed"
        );
        assert!(
            !outside.join(AUDIO_DIR_NAME).exists(),
            "a refused root must not create anything in the directory it pointed at"
        );
    }

    #[test]
    fn a_missing_root_chain_is_created_without_traversing_a_link() {
        let base = TemporaryDirectory::create();
        let app_data_dir = base.0.join("a").join("b").join("c");

        let held = open_managed_audio_dir_at(&app_data_dir)
            .expect("a root that does not exist yet must still be creatable");

        assert!(app_data_dir.join(AUDIO_DIR_NAME).is_dir());
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

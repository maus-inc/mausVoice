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

fn sanitize_id(id: &str) -> String {
    let mut sanitized = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();

    if sanitized.is_empty() {
        sanitized = "transcription".to_string();
    }

    sanitized
}

/// Derive the only filename that may represent this transcription's managed
/// snapshot. Database `audio_path` values are descriptive data, never
/// authority to select a file for deletion.
pub(crate) fn audio_file_name_for(transcription_id: &str) -> String {
    format!("{}.wav", sanitize_id(transcription_id))
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
        "Refusing a linked or reparse-point managed audio directory",
    )
}

#[cfg(windows)]
fn windows_attributes_include_reparse_point(attributes: u32) -> bool {
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

#[cfg(windows)]
fn is_windows_reparse_point(file: &std::fs::File) -> io::Result<bool> {
    use std::os::windows::fs::MetadataExt;

    Ok(windows_attributes_include_reparse_point(
        file.metadata()?.file_attributes(),
    ))
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_file: &std::fs::File) -> io::Result<bool> {
    Ok(false)
}

/// Open the managed directory as a capability, rather than resolving its path
/// and using that path later. The held handle stays bound to the directory that
/// was checked even if another process replaces its name. `maybe_dir` also
/// makes the Windows handle deny delete sharing, so Windows cannot rename or
/// delete the held directory while a cleanup batch is running.
fn open_managed_audio_dir_at(app_data_dir: &Path) -> io::Result<Dir> {
    fs::create_dir_all(app_data_dir)?;
    let app_data = Dir::open_ambient_dir(app_data_dir, cap_std::ambient_authority())?;

    if let Err(err) = app_data.create_dir(AUDIO_DIR_NAME) {
        if err.kind() != io::ErrorKind::AlreadyExists {
            return Err(err);
        }
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    let managed_directory = app_data.open_with(AUDIO_DIR_NAME, &options)?;
    let metadata = managed_directory.metadata()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(reject_managed_audio_reparse_point());
    }
    let managed_directory = managed_directory.into_std();
    // Windows opens a reparse point itself in no-follow mode. Its generic
    // file type can still look like a directory, so inspect the native
    // reparse bit before converting the handle into a directory capability.
    if is_windows_reparse_point(&managed_directory)? {
        return Err(reject_managed_audio_reparse_point());
    }

    Ok(Dir::from_std_file(managed_directory))
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
    let mut writer = WavWriter::new(audio_file, WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    })
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
        audio_file_name_for, delete_audio_file, open_audio_file_for_read, open_managed_audio_dir_at,
        AUDIO_DIR_NAME,
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
        assert_eq!(audio_file_name_for("session-42"), "session-42.wav");
        assert_eq!(audio_file_name_for("../../outside"), "outside.wav");
        assert_eq!(audio_file_name_for(""), "transcription.wav");
    }

    #[test]
    fn opens_a_regular_managed_audio_directory() {
        let root = TemporaryDirectory::create();
        let held_audio_dir = open_managed_audio_dir_at(&root.0)
            .expect("managed audio directory must be openable");

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
        let held_audio_dir = open_managed_audio_dir_at(&root.0)
            .expect("managed audio directory must be openable");
        let expected = root.audio_dir().join("known-id.wav");
        let outside = root.0.join("outside.wav");
        fs::write(&expected, b"managed").expect("managed fixture must be writable");
        fs::write(&outside, b"do not delete").expect("outside fixture must be writable");

        // A mutable `audio_path` could claim `outside.wav`; cleanup has no API
        // that accepts it, and instead derives `known-id.wav` from the ID.
        delete_audio_file(&held_audio_dir, "known-id")
            .expect("derived managed file must be removable");

        assert!(!expected.exists(), "the derived managed file must be removed");
        assert!(outside.exists(), "a tampered stored path must remain untouched");
    }

    #[cfg(unix)]
    #[test]
    fn held_directory_deletion_survives_root_replacement() {
        let root = TemporaryDirectory::create();
        let held_audio_dir = open_managed_audio_dir_at(&root.0)
            .expect("managed audio directory must be openable");
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
        let held_audio_dir = open_managed_audio_dir_at(&root.0)
            .expect("managed audio directory must be openable");
        let secret = root.0.join("secret.wav");
        fs::write(&secret, b"do not read").expect("secret fixture must be writable");
        symlink(&secret, root.audio_dir().join(audio_file_name_for("session")))
            .expect("final symlink must be creatable");

        assert!(
            open_audio_file_for_read(&held_audio_dir, "session").is_err(),
            "a final symlink must not be opened for audio reads"
        );
    }

    #[test]
    fn read_returns_a_handle_for_the_derived_regular_file() {
        let root = TemporaryDirectory::create();
        let held_audio_dir = open_managed_audio_dir_at(&root.0)
            .expect("managed audio directory must be openable");
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

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

pub fn audio_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|err| io::Error::other(err.to_string()))?;
    path.push(AUDIO_DIR_NAME);
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn audio_path_for(app: &tauri::AppHandle, transcription_id: &str) -> io::Result<PathBuf> {
    let mut path = audio_dir(app)?;
    path.push(format!("{}.wav", sanitize_id(transcription_id)));
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

    let path = audio_path_for(app, transcription_id)?;

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut writer = WavWriter::create(&path, spec).map_err(map_hound_error)?;
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

/// Resolve `path` to the exact managed entry that may be unlinked, or `None`
/// when it is not directly inside `audio_dir`. Canonicalizing the parent rather
/// than the final entry deliberately permits unlinking a final-position symlink
/// without following it, while rejecting `..` traversal and intermediate
/// symlinks out of the managed directory.
pub(crate) fn resolve_managed_audio_path_for_delete(
    path: &Path,
    audio_dir: &Path,
) -> Option<PathBuf> {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        audio_dir.join(path)
    };
    let file_name = candidate.file_name()?;
    let real_parent = fs::canonicalize(candidate.parent()?).ok()?;
    let real_audio_dir = fs::canonicalize(audio_dir).ok()?;
    (real_parent == real_audio_dir).then(|| real_parent.join(file_name))
}

pub fn delete_audio_file(app: &tauri::AppHandle, file_path: &Path) -> io::Result<()> {
    let audio_dir = audio_dir(app)?;
    let file_path = resolve_managed_audio_path_for_delete(file_path, &audio_dir).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to delete audio outside of managed directory",
        )
    })?;

    match fs::remove_file(file_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
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
    use super::resolve_managed_audio_path_for_delete;
    use std::fs;
    use std::path::{Path, PathBuf};
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
    }

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn create_audio_dir(root: &Path) -> PathBuf {
        let audio_dir = root.join("transcription-audio");
        fs::create_dir_all(&audio_dir).expect("managed audio directory must be creatable");
        audio_dir
    }

    #[test]
    fn delete_path_must_be_a_direct_managed_child_after_normalization() {
        let root = TemporaryDirectory::create();
        let audio_dir = create_audio_dir(&root.0);
        let managed = audio_dir.join("clip.wav");
        let outside = root.0.join("outside.wav");
        fs::write(&outside, b"do not delete").expect("outside fixture must be writable");

        assert_eq!(
            resolve_managed_audio_path_for_delete(&managed, &audio_dir),
            Some(managed.clone())
        );
        assert_eq!(
            resolve_managed_audio_path_for_delete(Path::new("clip.wav"), &audio_dir),
            Some(managed)
        );
        assert!(
            resolve_managed_audio_path_for_delete(&audio_dir.join("..").join("outside.wav"), &audio_dir)
                .is_none()
        );
        assert!(
            resolve_managed_audio_path_for_delete(Path::new("../outside.wav"), &audio_dir).is_none()
        );
        assert!(outside.exists(), "the rejected path must remain untouched");
    }

    #[cfg(unix)]
    #[test]
    fn delete_path_rejects_intermediate_symlinks_but_unlinks_a_final_symlink() {
        use std::os::unix::fs::symlink;

        let root = TemporaryDirectory::create();
        let audio_dir = create_audio_dir(&root.0);
        let outside_dir = root.0.join("outside");
        fs::create_dir_all(&outside_dir).expect("outside fixture directory must be creatable");
        let outside_file = outside_dir.join("secret.wav");
        fs::write(&outside_file, b"do not delete").expect("outside fixture must be writable");

        let intermediate_link = audio_dir.join("redirect");
        symlink(&outside_dir, &intermediate_link).expect("intermediate symlink must be creatable");
        assert!(
            resolve_managed_audio_path_for_delete(&intermediate_link.join("secret.wav"), &audio_dir)
                .is_none()
        );

        let final_link = audio_dir.join("clip.wav");
        symlink(&outside_file, &final_link).expect("final symlink must be creatable");
        let resolved = resolve_managed_audio_path_for_delete(&final_link, &audio_dir)
            .expect("a final managed symlink may be unlinked without following it");
        fs::remove_file(resolved).expect("managed final symlink must be removable");
        assert!(
            outside_file.exists(),
            "unlinking the managed link must not delete its outside target"
        );
    }
}

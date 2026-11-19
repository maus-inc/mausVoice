use std::io;
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use cap_std::fs::Dir;
use tauri::AppHandle;

use crate::system::{audio_store, paths::STORAGE_DIR_NAME};

/// Local repository for app-owned files such as app icons.
pub struct StorageRepo {
    base_dir: Dir,
}

impl StorageRepo {
    /// Opens the application's storage directory without following links.
    pub fn new(app: &AppHandle) -> io::Result<Self> {
        let base_dir = audio_store::open_storage_dir(app)?;
        Ok(Self { base_dir })
    }

    fn resolve_relative_path(&self, relative_path: &str) -> io::Result<PathBuf> {
        if relative_path.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Storage path cannot be empty",
            ));
        }

        let relative = Path::new(relative_path);
        if relative.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Absolute paths are not allowed in storage",
            ));
        }

        let mut normalized = PathBuf::new();
        for component in relative.components() {
            match component {
                Component::Normal(segment) => normalized.push(segment),
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Storage paths must not traverse outside the storage root",
                    ));
                }
                Component::Prefix(_) | Component::RootDir => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Storage paths must not contain root or prefix components",
                    ));
                }
            }
        }

        if normalized.components().next().is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Storage path cannot be empty or only '.' components",
            ));
        }

        Ok(normalized)
    }

    /// Deletes the app-owned storage tree without traversing linked directories.
    pub fn clear_storage_data(app: &AppHandle) -> io::Result<()> {
        let app_data = audio_store::open_app_data_dir(app)?;
        clear_storage_data_at(&app_data)
    }

    /// Uploads bytes below the held storage capability, creating parent directories as needed.
    pub fn upload_data(&self, relative_path: &str, data: &[u8]) -> io::Result<()> {
        let target_path = self.resolve_relative_path(relative_path)?;
        if let Some(parent) = target_path.parent() {
            if !parent.as_os_str().is_empty() {
                self.base_dir.create_dir_all(parent)?;
            }
        }
        self.base_dir.write(target_path, data)
    }

    /// Reads stored bytes and returns a data URL for the local file.
    pub fn get_download_url(&self, relative_path: &str) -> io::Result<String> {
        let target_path = self.resolve_relative_path(relative_path)?;
        let bytes = self.base_dir.read(target_path)?;
        let encoded = general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:application/octet-stream;base64,{encoded}"))
    }
}

fn clear_storage_data_at(app_data: &Dir) -> io::Result<()> {
    let metadata = match app_data.symlink_metadata(STORAGE_DIR_NAME) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Refusing to clear a linked app storage directory",
        ));
    }

    if metadata.is_dir() {
        app_data.remove_dir_all(STORAGE_DIR_NAME)
    } else {
        app_data.remove_file(STORAGE_DIR_NAME)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock must be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "mausvoice-storage-repo-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("failed to create test root");
            Self(path)
        }

        fn open(&self) -> Dir {
            Dir::open_ambient_dir(&self.0, cap_std::ambient_authority())
                .expect("failed to open test directory capability")
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_repo() -> (TestRoot, StorageRepo) {
        let root = TestRoot::new();
        let storage = root.0.join(STORAGE_DIR_NAME);
        fs::create_dir_all(&storage).expect("failed to create storage directory");
        let base_dir = Dir::open_ambient_dir(&storage, cap_std::ambient_authority())
            .expect("failed to open storage directory capability");
        (root, StorageRepo { base_dir })
    }

    #[test]
    fn rejects_empty_path() {
        let (_root, repo) = test_repo();
        assert!(repo.resolve_relative_path("").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        let (_root, repo) = test_repo();
        assert!(repo.resolve_relative_path("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(repo.resolve_relative_path("C:\\Windows\\System32").is_err());
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_root, repo) = test_repo();
        assert!(repo.resolve_relative_path("../secret").is_err());
        assert!(repo.resolve_relative_path("foo/../../bar").is_err());
        assert!(repo.resolve_relative_path("a/..").is_err());
        assert!(repo.resolve_relative_path("./..").is_err());
    }

    #[test]
    fn normalizes_nested_path_inside_base() {
        let (_root, repo) = test_repo();
        let resolved = repo
            .resolve_relative_path("audio/clip1.wav")
            .expect("valid nested path");
        assert_eq!(resolved, PathBuf::from("audio/clip1.wav"));
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("clip1.wav")
        );
    }

    #[test]
    fn uploads_and_reads_files_below_the_storage_capability() {
        let (_root, repo) = test_repo();
        repo.upload_data("user/app-icons/editor.png", &[1, 2, 3])
            .expect("upload should succeed");
        let url = repo
            .get_download_url("user/app-icons/editor.png")
            .expect("download should succeed");
        assert_eq!(url, "data:application/octet-stream;base64,AQID");
    }

    #[test]
    fn clears_app_storage_files_and_directories() {
        let root = TestRoot::new();
        let storage = root.0.join(STORAGE_DIR_NAME);
        fs::create_dir_all(storage.join("nested"))
            .expect("failed to create nested storage directory");
        fs::write(storage.join("nested/icon.png"), b"icon")
            .expect("failed to write storage fixture");

        clear_storage_data_at(&root.open()).expect("storage clear should succeed");

        assert!(!storage.exists());
    }

    #[cfg(unix)]
    #[test]
    fn clear_does_not_follow_symlinks_inside_storage() {
        use std::os::unix::fs::symlink;

        let root = TestRoot::new();
        let storage = root.0.join(STORAGE_DIR_NAME);
        let outside = root.0.join("outside");
        fs::create_dir_all(&storage).expect("failed to create storage directory");
        fs::create_dir_all(&outside).expect("failed to create outside directory");
        fs::write(outside.join("preserve.txt"), b"keep").expect("failed to write outside fixture");
        symlink(&outside, storage.join("linked")).expect("failed to create storage symlink");

        clear_storage_data_at(&root.open()).expect("storage clear should succeed");

        assert!(!storage.exists());
        assert_eq!(fs::read(outside.join("preserve.txt")).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_storage_root_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let root = TestRoot::new();
        let outside = root.0.join("outside");
        fs::create_dir_all(&outside).expect("failed to create outside directory");
        fs::write(outside.join("preserve.txt"), b"keep").expect("failed to write outside fixture");
        symlink(&outside, root.0.join(STORAGE_DIR_NAME)).expect("failed to create root symlink");

        let error = clear_storage_data_at(&root.open())
            .expect_err("a symlinked storage root must be rejected");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(outside.join("preserve.txt")).unwrap(), b"keep");
    }
}

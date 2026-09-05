use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WhisperModel {
    Tiny,
    Base,
    Small,
    Medium,
    Large,
    #[serde(
        alias = "large-turbo",
        alias = "large_v3_turbo",
        alias = "large-v3-turbo"
    )]
    Turbo,
    #[serde(
        rename = "parakeet-ctc-0.6b",
        alias = "parakeet-ctc",
        alias = "parakeet_ctc",
        alias = "parakeet_ctc_0.6b"
    )]
    ParakeetCtc06B,
    #[serde(
        rename = "parakeet-tdt-0.6b",
        alias = "parakeet-tdt",
        alias = "parakeet_tdt",
        alias = "parakeet_tdt_0.6b"
    )]
    ParakeetTdt06B,
    #[serde(rename = "canary-1b", alias = "canary", alias = "canary_1b")]
    Canary1B,
    #[serde(rename = "sense-voice", alias = "sensevoice", alias = "sense_voice")]
    SenseVoice,
}

impl WhisperModel {
    pub fn from_slug(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tiny" => Some(Self::Tiny),
            "base" => Some(Self::Base),
            "small" => Some(Self::Small),
            "medium" => Some(Self::Medium),
            "large" => Some(Self::Large),
            "turbo" | "large-turbo" | "large_v3_turbo" | "large-v3-turbo" => Some(Self::Turbo),
            "parakeet-ctc-0.6b" | "parakeet-ctc" | "parakeet_ctc" | "parakeet_ctc_0.6b" => {
                Some(Self::ParakeetCtc06B)
            }
            "parakeet-tdt-0.6b" | "parakeet-tdt" | "parakeet_tdt" | "parakeet_tdt_0.6b" => {
                Some(Self::ParakeetTdt06B)
            }
            "canary-1b" | "canary" | "canary_1b" => Some(Self::Canary1B),
            "sense-voice" | "sensevoice" | "sense_voice" => Some(Self::SenseVoice),
            _ => None,
        }
    }

    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Base => "base",
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
            Self::Turbo => "turbo",
            Self::ParakeetCtc06B => "parakeet-ctc-0.6b",
            Self::ParakeetTdt06B => "parakeet-tdt-0.6b",
            Self::Canary1B => "canary-1b",
            Self::SenseVoice => "sense-voice",
        }
    }

    pub fn is_onnx(self) -> bool {
        matches!(
            self,
            Self::ParakeetCtc06B | Self::ParakeetTdt06B | Self::Canary1B | Self::SenseVoice
        )
    }

    /// Filename of the progress-tracked primary artifact. ONNX artifacts are
    /// stored beneath a model-specific directory by [`Self::storage_path`].
    pub fn filename(self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
            Self::Medium => "ggml-medium.bin",
            Self::Large => "ggml-large-v3.bin",
            Self::Turbo => "ggml-large-v3-turbo.bin",
            // Track the largest artifact so completion cannot precede its
            // smaller graph/tokenizer companions under normal downloads.
            Self::ParakeetCtc06B => "model_int8.onnx_data",
            Self::ParakeetTdt06B => "encoder-model.int8.onnx",
            Self::Canary1B => "encoder-model.int8.onnx",
            Self::SenseVoice => "model.int8.onnx",
        }
    }

    /// Every file required by the model-specific runtime. ONNX artifacts are
    /// pinned to immutable Hugging Face revisions and every downloaded byte,
    /// including tokenizer/vocabulary companions, carries a SHA-256 digest.
    // PR #63 (#55 integration) — SenseVoice supply-chain pinning. Artifacts are pinned to an
    // immutable Hugging Face revision and every runtime file carries a SHA-256
    // digest so downloads are verified against tampering.
    // Source: csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
    //   revision 355f4d4884d8afd08aef04b9007a8556d7b463b2 (main)
    //   model.int8.onnx SHA-256 12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d
    //   tokens.txt SHA-256 f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
    // SENSEVOICE_REVISION and SENSEVOICE_DOWNLOAD_URL must stay in sync.
    const SENSEVOICE_REVISION: &str = "355f4d4884d8afd08aef04b9007a8556d7b463b2";
    const SENSEVOICE_MODEL_SHA256: &str =
        "12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d";
    const SENSEVOICE_TOKENS_SHA256: &str =
        "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc";
    const SENSEVOICE_DOWNLOAD_URL: &str =
        "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/355f4d4884d8afd08aef04b9007a8556d7b463b2/model.int8.onnx";
    pub fn artifact_set(self) -> Vec<(&'static str, String, Option<&'static str>)> {
        match self {
            Self::ParakeetCtc06B => {
                let root = "https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/resolve/7df2cab7aed886b8b7f80d68a8214007e4847601/";
                vec![
                    (
                        "model_int8.onnx_data",
                        format!("{root}onnx/model_int8.onnx_data"),
                        Some("136207926beb9b3bc0779d7a96c179013f51b292c320e96ae7a341ef62ab53d9"),
                    ),
                    (
                        "model_int8.onnx",
                        format!("{root}onnx/model_int8.onnx"),
                        Some("4de804b59b7b839ca21b97b5e506e558a859301d9a231a537e43c8f521037348"),
                    ),
                    (
                        "tokenizer.json",
                        format!("{root}tokenizer.json"),
                        Some("f3f1dd45c3889ed2b5bf67180caf05f51d7d7e4948c20e5f24d8c24df9cc47aa"),
                    ),
                ]
            }
            Self::ParakeetTdt06B => {
                let root = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                        Some("6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
                    ),
                    (
                        "decoder_joint-model.int8.onnx",
                        format!("{root}decoder_joint-model.int8.onnx"),
                        Some("eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
                    ),
                    (
                        "vocab.txt",
                        format!("{root}vocab.txt"),
                        Some("d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
                    ),
                ]
            }
            Self::Canary1B => {
                let root = "https://huggingface.co/istupakov/canary-1b-v2-onnx/resolve/5ebc1520cef7b6b318b3526ad17adbfe00bc1bfc/";
                vec![
                    (
                        "encoder-model.int8.onnx",
                        format!("{root}encoder-model.int8.onnx"),
                        Some("6d96e9945898e5ace48f4efecd459ca1df81859730be27b8af6b197639403ee1"),
                    ),
                    (
                        "decoder-model.int8.onnx",
                        format!("{root}decoder-model.int8.onnx"),
                        Some("52d83aa7aad41fbbe4f9dfcd341d784735a6eb4c6eb0d3290fc27a0d8ac39abf"),
                    ),
                    (
                        "vocab.txt",
                        format!("{root}vocab.txt"),
                        Some("2c9efe6104fd29522ea27ce0e3aef5d37c690af4e5a4232e643e23ca403ffea3"),
                    ),
                ]
            }
            Self::SenseVoice => {
                let root = format!(
                    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/{}/",
                    Self::SENSEVOICE_REVISION
                );
                vec![
                    (
                        "model.int8.onnx",
                        format!("{root}model.int8.onnx"),
                        Some(Self::SENSEVOICE_MODEL_SHA256),
                    ),
                    (
                        "tokens.txt",
                        format!("{root}tokens.txt"),
                        Some(Self::SENSEVOICE_TOKENS_SHA256),
                    ),
                ]
            }
            // whisper.cpp ggml models are single blobs fetched through
            // `download_url()` and verified by `whisper_cpp_sha256()`.
            Self::Tiny
            | Self::Base
            | Self::Small
            | Self::Medium
            | Self::Large
            | Self::Turbo => Vec::new(),
        }
    }

    pub fn storage_path(self, models_dir: &Path) -> PathBuf {
        if self.is_onnx() {
            self.artifact_path(models_dir, self.filename())
        } else {
            models_dir.join(self.filename())
        }
    }

    /// Resolve one ONNX artifact in an isolated model directory.
    pub fn artifact_path(self, models_dir: &Path, filename: &str) -> PathBuf {
        models_dir.join(self.as_slug()).join(filename)
    }

    /// whisper.cpp ggml model hosting. Pinned to an immutable commit of the
    /// upstream mirror; every blob carries its Hugging Face LFS SHA-256
    /// (identical to the checksums in whisper.cpp's own download script).
    const WHISPER_CPP_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

    /// Pinned digests per whisper.cpp ggml blob at [`Self::WHISPER_CPP_REVISION`].
    /// Sources: Hugging Face repo API `lfs.oid` fields for the pinned tree.
    const fn whisper_cpp_sha256(self) -> Option<&'static str> {
        match self {
            Self::Tiny => {
                Some("be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21")
            }
            Self::Base => {
                Some("60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe")
            }
            Self::Small => {
                Some("1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b")
            }
            Self::Medium => {
                Some("6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208")
            }
            Self::Large => {
                Some("64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2")
            }
            Self::Turbo => {
                Some("1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69")
            }
            // ONNX models pin per-artifact digests in `artifact_set()`.
            Self::ParakeetCtc06B
            | Self::ParakeetTdt06B
            | Self::Canary1B
            | Self::SenseVoice => None,
        }
    }

    pub fn is_whisper_cpp(self) -> bool {
        matches!(
            self,
            Self::Tiny | Self::Base | Self::Small | Self::Medium | Self::Large | Self::Turbo
        )
    }

    /// Environment override checked separately so the pinned digest only ever
    /// vouches for the pinned URL: an overridden URL is never digest-checked.
    fn download_url_env_override(self) -> Option<String> {
        let env_suffix: String = self
            .as_slug()
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        let env_var = format!("RUST_TRANSCRIPTION_MODEL_URL_{env_suffix}");
        std::env::var(env_var)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// Resolved digest for the whisper.cpp path: pinned for the default URL,
    /// absent when a developer overrides the URL via the environment.
    pub fn download_sha256(self) -> Option<&'static str> {
        if !self.is_whisper_cpp() {
            return None;
        }
        if self.download_url_env_override().is_some() {
            return None;
        }
        self.whisper_cpp_sha256()
    }

    /// Resolve the download URL, optionally overridden by an environment variable.
    /// The variable name is derived from `as_slug()` mapped to uppercase
    /// alphanumeric with every non-alphanumeric character replaced by `_`.
    /// Example: `sense-voice` -> `RUST_TRANSCRIPTION_MODEL_URL_SENSE_VOICE`.
    pub fn download_url(self) -> String {
        if let Some(overridden) = self.download_url_env_override() {
            return overridden;
        }

        match self {
            // Whisper.cpp ggml binaries are pinned to an immutable revision of
            // the upstream mirror and carry the digests above, same as the
            // ONNX artifacts.
            Self::Tiny => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-tiny.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            Self::Base => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-base.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            Self::Small => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-small.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            Self::Medium => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-medium.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            Self::Large => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-large-v3.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            Self::Turbo => {
                return format!(
                    "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-large-v3-turbo.bin",
                    Self::WHISPER_CPP_REVISION
                );
            }
            // ONNX models are downloaded through `artifact_set()`, which pins
            // each artifact to an immutable Hugging Face revision and verifies
            // its digest, so they intentionally have no `download_url` arm: the
            // mutable `/resolve/main/` ONNX URLs would be incorrect to expose
            // here.
            Self::SenseVoice => {
                // Pin the primary download URL to the same immutable revision.
                Self::SENSEVOICE_DOWNLOAD_URL
            }
            // ONNX companions are fetched via `artifact_set()`, not this URL.
            Self::ParakeetCtc06B | Self::ParakeetTdt06B | Self::Canary1B => {
                return String::new();
            }
        }
        .to_string()
    }

    pub fn supported() -> &'static [&'static str] {
        &[
            "tiny",
            "base",
            "small",
            "medium",
            "large",
            "turbo",
            "parakeet-ctc-0.6b",
            "parakeet-tdt-0.6b",
            "canary-1b",
            "sense-voice",
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onnx_models_have_isolated_storage_paths() {
        let root = Path::new("models");
        let tdt = WhisperModel::ParakeetTdt06B.storage_path(root);
        let canary = WhisperModel::Canary1B.storage_path(root);

        assert_ne!(tdt, canary);
        assert_eq!(
            tdt,
            root.join("parakeet-tdt-0.6b")
                .join("encoder-model.int8.onnx")
        );
        assert_eq!(
            canary,
            root.join("canary-1b").join("encoder-model.int8.onnx")
        );
    }

    #[test]
    fn onnx_primary_is_first_in_artifact_set() {
        let onnx_models: Vec<WhisperModel> = WhisperModel::supported()
            .iter()
            .filter_map(|slug| WhisperModel::from_slug(slug))
            .filter(|model| model.is_onnx())
            .collect();
        assert!(!onnx_models.is_empty());

        for model in onnx_models {
            let artifacts = model.artifact_set();
            assert_eq!(
                artifacts.first().map(|artifact| artifact.0),
                Some(model.filename())
            );
            assert!(artifacts.len() > 1);
            assert!(artifacts.iter().all(|(_, url, _)| {
                url.starts_with("https://huggingface.co/") && !url.contains("/resolve/main/")
            }));
            // Every runtime artifact affects inference or decoding, so model
            // graphs and tokenizer/vocabulary companions must all be pinned.
            assert!(
                artifacts.iter().all(|(_, _, sha256)| sha256.is_some()),
                "every ONNX runtime artifact for {model:?} must be digest-pinned"
            );
        }
    }

    #[test]
    fn sensevoice_uses_immutable_revision_and_digest() {
        let artifacts = WhisperModel::SenseVoice.artifact_set();
        // No artifact may be served from the mutable `main` branch, and no
        // placeholder text may survive.
        assert!(artifacts
            .iter()
            .all(|(_, url, _)| !url.contains("/resolve/main/")));
        assert!(artifacts.iter().all(|(_, url, _)| !url.contains("REPLACE")));
        // The executable graph must carry a verified digest.
        let (_, _, digest) = &artifacts[0];
        let digest = digest.expect("SenseVoice primary graph must be digest-pinned");
        // The pinned revision must be an immutable 40-char commit SHA, not a
        // placeholder or the mutable `main` branch.
        assert_eq!(
            WhisperModel::SENSEVOICE_REVISION.len(),
            40,
            "SenseVoice must pin an immutable 40-char commit SHA, not a placeholder"
        );
        assert!(
            WhisperModel::SENSEVOICE_REVISION
                .chars()
                .all(|c| c.is_ascii_hexdigit()),
            "SenseVoice revision must be a hexadecimal commit SHA"
        );
        assert!(
            !WhisperModel::SENSEVOICE_REVISION.contains("REPLACE")
                && WhisperModel::SENSEVOICE_REVISION != "main",
            "SenseVoice revision must not be a placeholder or `main`"
        );
        // The digest must be a 64-char SHA-256.
        assert_eq!(
            digest.len(),
            64,
            "SenseVoice digest must be a 64-char SHA-256, not a placeholder"
        );
        assert!(
            digest.chars().all(|c| c.is_ascii_hexdigit()),
            "SenseVoice digest must be a hexadecimal SHA-256"
        );
        // The vocabulary affects token-to-text decoding and must not be
        // indefinitely admitted merely because it is non-empty.
        assert!(
            artifacts.iter().all(|(_, _, sha256)| sha256.is_some()),
            "every SenseVoice runtime artifact, including tokens.txt, must be digest-pinned"
        );
        // The primary download URL must also be revision-pinned.
        assert!(
            !WhisperModel::SenseVoice
                .download_url()
                .contains("/resolve/main/"),
            "SenseVoice download URL must not use the mutable main branch"
        );
    }

    #[test]
    fn whisper_cpp_models_have_valid_filenames() {
        for slug in ["tiny", "base", "small", "medium", "large", "turbo"] {
            let model = WhisperModel::from_slug(slug).expect("supported whisper slug must parse");
            assert!(model.filename().starts_with("ggml-"));
            assert!(model.filename().ends_with(".bin"));
        }
    }

    #[test]
    fn whisper_cpp_downloads_are_revision_pinned_and_digest_checked() {
        // Iterates every supported ggml variant so a newly added slug is
        // pinned from day one; ONNX artifacts are checked in
        // `onnx_primary_is_first_in_artifact_set`.
        let ggml_models: Vec<(&str, WhisperModel)> = WhisperModel::supported()
            .iter()
            .filter_map(|slug| WhisperModel::from_slug(slug).map(|model| (*slug, model)))
            .filter(|(_, model)| !model.is_onnx())
            .collect();
        assert!(ggml_models.len() >= 6, "expected the six whisper.cpp variants");

        for (slug, model) in ggml_models {
            let url = model.download_url();
            assert!(
                url.contains(&format!("/resolve/{}/", WhisperModel::WHISPER_CPP_REVISION)),
                "whisper.cpp {slug} URL must pin the immutable revision: {url}"
            );
            assert!(!url.contains("/resolve/main/"));

            let digest = model
                .download_sha256()
                .expect("whisper.cpp model must carry a pinned digest");
            assert_eq!(digest.len(), 64, "{slug} digest must be SHA-256 hex");
            assert!(
                digest.chars().all(|c| c.is_ascii_hexdigit()),
                "{slug} digest must be lowercase hex: {digest}"
            );
        }

        assert_eq!(WhisperModel::WHISPER_CPP_REVISION.len(), 40);
        assert!(WhisperModel::WHISPER_CPP_REVISION
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn whisper_cpp_env_override_supplies_url_and_suppresses_the_pin() {
        // Parallel cargo tests share the process environment, so serialize
        // access and restore the value on drop.
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        struct EnvRestore {
            key: &'static str,
            original: Option<String>,
        }
        impl Drop for EnvRestore {
            fn drop(&mut self) {
                if let Some(value) = &self.original {
                    std::env::set_var(self.key, value);
                } else {
                    std::env::remove_var(self.key);
                }
            }
        }

        let _guard = ENV_LOCK.lock().unwrap();
        let _restore = EnvRestore {
            key: "RUST_TRANSCRIPTION_MODEL_URL_TINY",
            original: std::env::var("RUST_TRANSCRIPTION_MODEL_URL_TINY").ok(),
        };

        std::env::set_var(
            "RUST_TRANSCRIPTION_MODEL_URL_TINY",
            "http://127.0.0.1:1234/local-tiny.bin",
        );
        let tiny = WhisperModel::from_slug("tiny").expect("tiny parses");
        assert_eq!(
            tiny.download_url(),
            "http://127.0.0.1:1234/local-tiny.bin"
        );
        // A developer-supplied URL never wears the upstream digest.
        assert_eq!(tiny.download_sha256(), None);
    }

    #[test]
    fn unsupported_transformers_checkpoint_is_not_exposed_as_a_ggml_model() {
        assert_eq!(WhisperModel::from_slug("hindi2hinglish"), None);
        assert_eq!(WhisperModel::from_slug("hindi2hinglish-apex"), None);
    }
}

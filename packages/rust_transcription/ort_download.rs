use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// One download attempt's outcome, split so the caller can tell a definitive
/// "this source does not have the file" apart from a transient network fault.
/// A 404 must move straight to the next source rather than replay three times,
/// while a timeout or a 5xx is worth retrying against the same source.
struct DownloadError {
    message: String,
    retryable: bool,
}

impl DownloadError {
    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

pub(crate) fn download_config(
    header_timeout: Duration,
) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        // ureq 3.4 records SendRequest when the GET headers have been sent.
        // That timestamp bounds RecvResponse across partial reads, and RecvBody
        // does not inherit it. A RecvResponse timeout instead restarts each
        // header read and can then constrain the body.
        .timeout_send_request(Some(header_timeout))
        .timeout_recv_body(Some(Duration::from_secs(300)))
}

pub(crate) fn download_verified(
    asset: (&str, &str),
    archive_path: &Path,
    base_urls: &[String],
    agent: &ureq::Agent,
    wait: impl Fn(Duration),
) -> Result<(), String> {
    let (archive_name, expected_sha256) = asset;
    let temporary_path = archive_path.with_extension(format!(
        "{}.{}.part",
        archive_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("archive"),
        std::process::id()
    ));

    let mut failures = Vec::with_capacity(base_urls.len());
    for (index, base_url) in base_urls.iter().enumerate() {
        let url = format!("{base_url}/{archive_name}");
        for attempt in 1..=3 {
            let result = (|| -> Result<(), DownloadError> {
                let mut response = agent.get(&url).call().map_err(request_error)?;
                let mut reader = response
                    .body_mut()
                    .with_config()
                    .limit(MAX_DOWNLOAD_BYTES)
                    .reader();
                let mut output = File::create(&temporary_path).map_err(|error| {
                    DownloadError::transient(format!("failed to create download: {error}"))
                })?;
                let mut hasher = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];

                loop {
                    let count = reader.read(&mut buffer).map_err(|error| {
                        DownloadError::transient(format!(
                            "failed to read response body: {}",
                            error.kind()
                        ))
                    })?;
                    if count == 0 {
                        break;
                    }
                    output.write_all(&buffer[..count]).map_err(|error| {
                        DownloadError::transient(format!("failed to write download: {error}"))
                    })?;
                    hasher.update(&buffer[..count]);
                }
                output.sync_all().map_err(|error| {
                    DownloadError::transient(format!("failed to flush download: {error}"))
                })?;

                let actual = format!("{:x}", hasher.finalize());
                if actual != expected_sha256 {
                    // A digest mismatch means this source served the wrong bytes,
                    // which no retry against it will fix. Reject it and move on.
                    return Err(DownloadError::terminal(format!(
                        "SHA-256 mismatch (expected {expected_sha256}, got {actual})"
                    )));
                }
                Ok(())
            })();

            match result {
                Ok(()) => {
                    return fs::rename(&temporary_path, archive_path).map_err(|error| {
                        let _ = fs::remove_file(&temporary_path);
                        format!(
                            "failed to store verified ONNX Runtime archive: {}",
                            error.kind()
                        )
                    });
                }
                Err(error) => {
                    let _ = fs::remove_file(&temporary_path);
                    if !error.retryable || attempt == 3 {
                        // URLs and HTTP-library errors can contain credentials. Use
                        // the position in the configured source list instead.
                        failures.push(format!("source {}: {}", index + 1, error.message));
                        break;
                    }
                    wait(Duration::from_secs(attempt * 2));
                }
            }
        }
    }

    Err(format!(
        "failed to download verified ONNX Runtime archive '{archive_name}': {}",
        failures.join("; ")
    ))
}

fn request_error(error: ureq::Error) -> DownloadError {
    match error {
        ureq::Error::StatusCode(code) if (400..500).contains(&code) => {
            DownloadError::terminal(format!("HTTP {code}"))
        }
        ureq::Error::StatusCode(code) => DownloadError::transient(format!("HTTP {code}")),
        ureq::Error::Timeout(ureq::Timeout::SendRequest) => DownloadError::transient(
            "timed out sending the request or waiting for response headers",
        ),
        ureq::Error::Timeout(phase) => {
            DownloadError::transient(format!("request timed out: {phase:?}"))
        }
        ureq::Error::BadUri(_) | ureq::Error::Http(_) => {
            DownloadError::terminal("invalid request URL")
        }
        ureq::Error::HostNotFound => DownloadError::transient("source hostname did not resolve"),
        ureq::Error::Io(error) => {
            DownloadError::transient(format!("request I/O failed: {}", error.kind()))
        }
        _ => DownloadError::transient("request failed before a response was received"),
    }
}

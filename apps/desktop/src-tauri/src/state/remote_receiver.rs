use std::sync::{Arc, Mutex};

use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReceiverStatus {
    pub enabled: bool,
    pub device_id: String,
    pub device_name: String,
    pub listen_address: Option<String>,
    pub port: Option<u16>,
    pub pairing_code: String,
    pub last_sender_device_id: Option<String>,
    pub last_event_id: Option<String>,
    pub last_delivery_status: Option<String>,
    pub last_delivery_at: Option<String>,
    pub last_error: Option<String>,
    pub last_target_class_name: Option<String>,
    pub last_target_title: Option<String>,
    pub last_target_editable: Option<bool>,
    pub device_platform: String,
}

#[derive(Default)]
pub(crate) struct RemoteReceiverEventDetails {
    pub(crate) sender_device_id: Option<String>,
    pub(crate) event_id: Option<String>,
    pub(crate) target_class_name: Option<String>,
    pub(crate) target_title: Option<String>,
    pub(crate) target_editable: Option<bool>,
}

struct RemoteReceiverStateInner {
    status: RemoteReceiverStatus,
    shutdown: Option<watch::Sender<bool>>,
    generation: u64,
}

#[derive(Clone)]
pub struct RemoteReceiverState {
    inner: Arc<Mutex<RemoteReceiverStateInner>>,
}

impl Default for RemoteReceiverState {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteReceiverState {
    pub fn new() -> Self {
        let device_name = hostname::get()
            .ok()
            .and_then(|value| value.into_string().ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "mausVoice Desktop".to_string());

        let mut hasher = Sha256::new();
        hasher.update(device_name.as_bytes());
        let digest = hasher.finalize();
        let device_id = format!("device-{digest:x}")[..23].to_string();

        Self {
            inner: Arc::new(Mutex::new(RemoteReceiverStateInner {
                status: RemoteReceiverStatus {
                    enabled: false,
                    device_id,
                    device_name,
                    listen_address: None,
                    port: None,
                    pairing_code: generate_pairing_code(),
                    last_sender_device_id: None,
                    last_event_id: None,
                    last_delivery_status: None,
                    last_delivery_at: None,
                    last_error: None,
                    last_target_class_name: None,
                    last_target_title: None,
                    last_target_editable: None,
                    device_platform: std::env::consts::OS.to_string(),
                },
                shutdown: None,
                generation: 0,
            })),
        }
    }

    pub fn status(&self) -> RemoteReceiverStatus {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.lock().unwrap().status.enabled
    }

    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().generation
    }

    pub fn is_generation_active(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.status.enabled && inner.generation == generation
    }

    pub fn start(&self, listen_address: String, port: u16, shutdown: watch::Sender<bool>) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1);
        inner.status.enabled = true;
        inner.status.listen_address = Some(listen_address);
        inner.status.port = Some(port);
        inner.status.pairing_code = generate_pairing_code();
        inner.shutdown = Some(shutdown);
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(shutdown) = inner.shutdown.take() {
            let _ = shutdown.send(true);
        }
        inner.status.enabled = false;
        inner.status.listen_address = None;
        inner.status.port = None;
    }

    pub fn rotate_pairing_code_for_generation(&self, generation: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.status.enabled || inner.generation != generation {
            return false;
        }
        inner.status.pairing_code = generate_pairing_code();
        true
    }

    pub(crate) fn record_delivery_for_generation(
        &self,
        generation: u64,
        details: RemoteReceiverEventDetails,
        delivered_at: Option<String>,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.status.enabled || inner.generation != generation {
            return false;
        }
        apply_event_details(&mut inner.status, details);
        inner.status.last_delivery_status = Some("delivered".to_string());
        inner.status.last_delivery_at = delivered_at;
        inner.status.last_error = None;
        true
    }

    pub(crate) fn record_error_for_generation(
        &self,
        generation: u64,
        details: RemoteReceiverEventDetails,
        message: String,
    ) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if !inner.status.enabled || inner.generation != generation {
            return false;
        }
        apply_event_details(&mut inner.status, details);
        inner.status.last_delivery_status = Some("failed".to_string());
        inner.status.last_error = Some(message);
        inner.status.last_delivery_at = Some(chrono::Utc::now().to_rfc3339());
        true
    }
}

/// Copy the event identity and target details shared by delivered and failed
/// deliveries, leaving the outcome fields to the caller.
fn apply_event_details(status: &mut RemoteReceiverStatus, details: RemoteReceiverEventDetails) {
    status.last_sender_device_id = details.sender_device_id;
    status.last_event_id = details.event_id;
    status.last_target_class_name = details.target_class_name;
    status.last_target_title = details.target_title;
    status.last_target_editable = details.target_editable;
}

fn generate_pairing_code() -> String {
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{RemoteReceiverEventDetails, RemoteReceiverState};

    #[test]
    fn stopping_and_restarting_invalidates_accepted_connections() {
        let state = RemoteReceiverState::new();
        let (shutdown, _receiver) = tokio::sync::watch::channel(false);
        state.start("127.0.0.1".to_string(), 1234, shutdown);
        let first_generation = state.generation();
        assert!(state.is_generation_active(first_generation));

        state.stop();
        assert!(!state.is_generation_active(first_generation));
        assert!(!state.record_error_for_generation(
            first_generation,
            RemoteReceiverEventDetails {
                sender_device_id: Some("stale-sender".to_string()),
                ..RemoteReceiverEventDetails::default()
            },
            "stale error".to_string(),
        ));
        assert!(!state.record_delivery_for_generation(
            first_generation,
            RemoteReceiverEventDetails {
                sender_device_id: Some("stale-sender".to_string()),
                event_id: Some("stale-event".to_string()),
                ..RemoteReceiverEventDetails::default()
            },
            None,
        ));
        assert!(!state.rotate_pairing_code_for_generation(first_generation));
        assert_eq!(state.status().last_error, None);
        assert_eq!(state.status().last_event_id, None);

        let (shutdown, _receiver) = tokio::sync::watch::channel(false);
        state.start("127.0.0.1".to_string(), 1235, shutdown);
        let second_generation = state.generation();
        assert_ne!(first_generation, second_generation);
        assert!(!state.is_generation_active(first_generation));
        assert!(state.is_generation_active(second_generation));
    }
}

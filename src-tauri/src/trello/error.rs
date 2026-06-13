//! Error type for the Trello module.
//!
//! Uses `thiserror` for `Display`/`Error`/`From` boilerplate, and provides a
//! manual `Serialize` impl so the frontend can `JSON.parse` structured errors
//! out of the `Result<T, String>` envelope that Tauri commands return.

use serde::ser::{Serialize, SerializeMap, Serializer};
use thiserror::Error;

use super::types::ApiErrorEnvelope;

/// Top-level error for every Trello-module call.
#[derive(Debug, Error)]
pub enum TrelloError {
    /// HTTP-level error: the server responded with a non-2xx status. `code`
    /// and `message` come from the API envelope; if the body wasn't a valid
    /// envelope we synthesize `code = "unknown"` and copy the raw body
    /// (truncated) into `message`.
    #[error("http {status} {code}: {message}")]
    Http {
        status: u16,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },

    /// Network / TLS / timeout / DNS / connect error.
    #[error("transport error: {0}")]
    Transport(#[from] reqwest::Error),

    /// Response body did not deserialize into the expected DTO.
    #[error("decode error: {0}")]
    Decode(#[from] serde_json::Error),

    /// Configuration problem (bad base_url, empty api_key, missing app dir).
    #[error("invalid configuration: {0}")]
    InvalidConfig(String),

    /// Frontend called a command before `trello_configure` ran.
    #[error("trello client not configured — call trello_configure first")]
    NotConfigured,

    /// Local file I/O for the trello.json config file failed.
    #[error("io error: {0}")]
    Io(String),
}

impl TrelloError {
    /// Build a `TrelloError::Http` from a raw response body.
    ///
    /// If the body parses as the API's `{ "error": { ... } }` envelope we use
    /// its fields directly. Otherwise we keep `code = "unknown"` and copy the
    /// raw text (truncated to 512 chars) into `message` so logs aren't blank.
    pub fn from_response_body(status: u16, body: &[u8]) -> Self {
        // Try the envelope first.
        if let Ok(env) = serde_json::from_slice::<ApiErrorEnvelope>(body) {
            return TrelloError::Http {
                status,
                code: env.error.code,
                message: env.error.message,
                details: env.error.details,
            };
        }

        // Fallback: keep something useful in `message`.
        let raw = String::from_utf8_lossy(body);
        let truncated: String = raw.chars().take(512).collect();
        TrelloError::Http {
            status,
            code: "unknown".to_string(),
            message: if truncated.is_empty() {
                format!("HTTP {status}")
            } else {
                truncated
            },
            details: None,
        }
    }

    /// Serialize self into the structured-string payload Tauri commands return
    /// inside `Result<T, String>`. The frontend `JSON.parse`s it.
    pub fn to_frontend_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.to_string())
    }
}

impl From<std::io::Error> for TrelloError {
    fn from(e: std::io::Error) -> Self {
        TrelloError::Io(e.to_string())
    }
}

/// Custom serialize so the frontend gets `{ kind, status?, code?, message }`
/// instead of the default enum serialization, which would leak Rust variant
/// names like `"Http"` / `"Transport"`.
impl Serialize for TrelloError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            TrelloError::Http {
                status,
                code,
                message,
                details,
            } => {
                let mut map = s.serialize_map(Some(5))?;
                map.serialize_entry("kind", "http")?;
                map.serialize_entry("status", status)?;
                map.serialize_entry("code", code)?;
                map.serialize_entry("message", message)?;
                if let Some(d) = details {
                    map.serialize_entry("details", d)?;
                }
                map.end()
            }
            TrelloError::Transport(e) => {
                // SAFETY: nunca exponer e.to_string() al frontend — reqwest::Error
                // puede incluir la request URL (con headers? no, pero por las
                // dudas evitamos derivar mensajes desde el error completo).
                // Mapeamos a categoría safe basada en kind flags.
                let safe_message = if e.is_timeout() {
                    "request timed out"
                } else if e.is_connect() {
                    "connection failed"
                } else if e.is_request() {
                    "request error"
                } else if e.is_decode() {
                    "response decode error"
                } else if e.is_body() {
                    "body read error"
                } else {
                    "transport error"
                };
                let mut map = s.serialize_map(Some(2))?;
                map.serialize_entry("kind", "transport")?;
                map.serialize_entry("message", safe_message)?;
                map.end()
            }
            TrelloError::Decode(e) => {
                let mut map = s.serialize_map(Some(2))?;
                map.serialize_entry("kind", "decode")?;
                map.serialize_entry("message", &e.to_string())?;
                map.end()
            }
            TrelloError::InvalidConfig(msg) => {
                let mut map = s.serialize_map(Some(2))?;
                map.serialize_entry("kind", "invalid_config")?;
                map.serialize_entry("message", msg)?;
                map.end()
            }
            TrelloError::NotConfigured => {
                let mut map = s.serialize_map(Some(2))?;
                map.serialize_entry("kind", "not_configured")?;
                map.serialize_entry("message", "trello client not configured")?;
                map.end()
            }
            TrelloError::Io(msg) => {
                let mut map = s.serialize_map(Some(2))?;
                map.serialize_entry("kind", "io")?;
                map.serialize_entry("message", msg)?;
                map.end()
            }
        }
    }
}

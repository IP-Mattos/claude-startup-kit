//! HTTP client for the Trello equipo API.
//!
//! Wraps `reqwest::Client` and exposes typed async methods. The `api_key` is
//! injected per-request (NOT as a default header) so it never leaks if the
//! client is ever Debug-printed.

use std::time::Duration;

use reqwest::{header, Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use url::Url;

use super::error::TrelloError;
use super::types::{
    ChangesPage, Column, CompleteOutcome, CompleteTaskBody, CreateTaskPayload, ImportResult,
    ListEnvelope, Member, MoveTaskBody, Page, PatchTaskPayload, Profile, Project, ProjectsFilter,
    ResponseMeta, Task, TasksFilter,
};

const REPLAY_HEADER: &str = "x-idempotent-replay";
const PARTIAL_COMPLETE_HEADER: &str = "x-partial-complete";

/// Async, clone-cheap client. Holds a `reqwest::Client` (internally `Arc`),
/// a parsed base URL, and the bearer token.
///
/// `Debug` is implemented MANUALLY to redact `api_key` — never derive Debug
/// on this struct, the bearer token leaks via dbg!() / panic messages.
#[derive(Clone)]
pub struct TrelloClient {
    base_url: Url,
    api_key: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for TrelloClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrelloClient")
            .field("base_url", &self.base_url.as_str())
            .field("api_key", &"***redacted***")
            .field("http", &"<reqwest::Client>")
            .finish()
    }
}

impl TrelloClient {
    /// Build a new client. Parses `base_url` once and configures sensible
    /// timeouts. Returns `InvalidConfig` if `base_url` is malformed or
    /// `api_key` is empty after trimming.
    pub fn new(base_url: &str, api_key: impl Into<String>) -> Result<Self, TrelloError> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            return Err(TrelloError::InvalidConfig("api_key is empty".to_string()));
        }

        // Ensure base_url ends with `/` so `Url::join` does not strip the last
        // path segment ("…/api/v1" + "me" would become "…/api/me" otherwise).
        let normalized = if base_url.ends_with('/') {
            base_url.to_string()
        } else {
            format!("{base_url}/")
        };

        let parsed = Url::parse(&normalized)
            .map_err(|e| TrelloError::InvalidConfig(format!("base_url: {e}")))?;

        // Enforce HTTPS — refuse plain HTTP to prevent bearer leak over MITM.
        if parsed.scheme() != "https" {
            return Err(TrelloError::InvalidConfig(
                "base_url debe usar esquema https://".to_string(),
            ));
        }

        let http = reqwest::Client::builder()
            .user_agent(concat!("csk-trello/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()?;

        Ok(Self {
            base_url: parsed,
            api_key,
            http,
        })
    }

    /// Build a `RequestBuilder` with the `Authorization: Bearer …` header
    /// already attached. `path` is appended onto `base_url` via `Url::join`,
    /// which correctly handles single/double slashes.
    fn request(&self, method: Method, path: &str) -> Result<RequestBuilder, TrelloError> {
        // Strip a leading `/` so `join` does not treat the path as absolute
        // (which would discard the base_url path entirely).
        let path = path.trim_start_matches('/');
        let url = self
            .base_url
            .join(path)
            .map_err(|e| TrelloError::InvalidConfig(format!("path join {path}: {e}")))?;
        Ok(self
            .http
            .request(method, url)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.api_key)))
    }

    /// Send a request, parse the response. On non-2xx, attempt to read the
    /// API error envelope. On 2xx, deserialize the body into `T`. Collects
    /// metadata headers (replay, partial-complete) into the second tuple slot.
    async fn send<T: DeserializeOwned>(
        &self,
        mut req: RequestBuilder,
        idem: Option<&str>,
    ) -> Result<(T, ResponseMeta), TrelloError> {
        if let Some(key) = idem {
            req = req.header("Idempotency-Key", key);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let meta = extract_meta(&resp);
        let bytes = resp.bytes().await?;

        if !status.is_success() {
            return Err(TrelloError::from_response_body(status.as_u16(), &bytes));
        }

        let value: T = serde_json::from_slice(&bytes)?;
        Ok((value, meta))
    }

    /// Same as `send` but returns no body (for 204 endpoints like DELETE).
    async fn send_no_body(
        &self,
        mut req: RequestBuilder,
        idem: Option<&str>,
    ) -> Result<ResponseMeta, TrelloError> {
        if let Some(key) = idem {
            req = req.header("Idempotency-Key", key);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let meta = extract_meta(&resp);
        if status == StatusCode::NO_CONTENT || status.is_success() {
            return Ok(meta);
        }
        let bytes = resp.bytes().await?;
        Err(TrelloError::from_response_body(status.as_u16(), &bytes))
    }

    // ------- Read endpoints -------

    pub async fn me(&self) -> Result<Profile, TrelloError> {
        let req = self.request(Method::GET, "me")?;
        let (profile, _) = self.send::<Profile>(req, None).await?;
        Ok(profile)
    }

    pub async fn projects(&self, filter: &ProjectsFilter) -> Result<Page<Project>, TrelloError> {
        let req = self.request(Method::GET, "projects")?.query(filter);
        let (page, _) = self.send::<Page<Project>>(req, None).await?;
        Ok(page)
    }

    pub async fn project(&self, id: &str) -> Result<Project, TrelloError> {
        let req = self.request(Method::GET, &format!("projects/{id}"))?;
        let (p, _) = self.send::<Project>(req, None).await?;
        Ok(p)
    }

    pub async fn columns(&self, project_id: &str) -> Result<Vec<Column>, TrelloError> {
        let req = self.request(Method::GET, &format!("projects/{project_id}/columns"))?;
        let (env, _) = self.send::<ListEnvelope<Column>>(req, None).await?;
        Ok(env.data)
    }

    pub async fn members(&self, project_id: &str) -> Result<Vec<Member>, TrelloError> {
        let req = self.request(Method::GET, &format!("projects/{project_id}/members"))?;
        let (env, _) = self.send::<ListEnvelope<Member>>(req, None).await?;
        Ok(env.data)
    }

    pub async fn tasks(&self, filter: &TasksFilter) -> Result<Page<Task>, TrelloError> {
        let req = self.request(Method::GET, "tasks")?.query(filter);
        let (page, _) = self.send::<Page<Task>>(req, None).await?;
        Ok(page)
    }

    pub async fn task(&self, id: &str) -> Result<Task, TrelloError> {
        let req = self.request(Method::GET, &format!("tasks/{id}"))?;
        let (t, _) = self.send::<Task>(req, None).await?;
        Ok(t)
    }

    // ------- Write endpoints (POST/PATCH/DELETE/move/complete) -------

    pub async fn create_task(
        &self,
        payload: &CreateTaskPayload,
        idem: Option<&str>,
    ) -> Result<Task, TrelloError> {
        let req = self.request(Method::POST, "tasks")?.json(payload);
        let (t, _) = self.send::<Task>(req, idem).await?;
        Ok(t)
    }

    pub async fn patch_task(
        &self,
        id: &str,
        payload: &PatchTaskPayload,
        idem: Option<&str>,
    ) -> Result<Task, TrelloError> {
        let req = self
            .request(Method::PATCH, &format!("tasks/{id}"))?
            .json(payload);
        let (t, _) = self.send::<Task>(req, idem).await?;
        Ok(t)
    }

    pub async fn move_task(
        &self,
        id: &str,
        body: &MoveTaskBody,
        idem: Option<&str>,
    ) -> Result<Task, TrelloError> {
        let req = self
            .request(Method::POST, &format!("tasks/{id}/move"))?
            .json(body);
        let (t, _) = self.send::<Task>(req, idem).await?;
        Ok(t)
    }

    pub async fn complete_task(
        &self,
        id: &str,
        body: &CompleteTaskBody,
        idem: Option<&str>,
    ) -> Result<CompleteOutcome, TrelloError> {
        let req = self
            .request(Method::POST, &format!("tasks/{id}/complete"))?
            .json(body);
        let (task, meta) = self.send::<Task>(req, idem).await?;
        let requires_supervisor_approval = meta
            .partial_complete
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("requires_supervisor_approval"))
            .unwrap_or(false);
        Ok(CompleteOutcome {
            task,
            requires_supervisor_approval,
        })
    }

    /// Delete a task. 204 → Ok(()). 404 is propagated as
    /// `TrelloError::Http { status: 404, .. }`; the command layer decides
    /// whether to swallow it (replay-safe with idem key) or surface it.
    pub async fn delete_task(&self, id: &str, idem: Option<&str>) -> Result<(), TrelloError> {
        let req = self.request(Method::DELETE, &format!("tasks/{id}"))?;
        self.send_no_body(req, idem).await?;
        Ok(())
    }

    /// Catchup polling endpoint.
    pub async fn changes(
        &self,
        since: &str,
        project_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<ChangesPage, TrelloError> {
        let mut req = self.request(Method::GET, "changes")?.query(&[("since", since)]);
        if let Some(pid) = project_id {
            req = req.query(&[("project_id", pid)]);
        }
        if let Some(l) = limit {
            req = req.query(&[("limit", l.to_string())]);
        }
        let (page, _) = self.send::<ChangesPage>(req, None).await?;
        Ok(page)
    }

    /// Bulk-import columns + tasks into a project (`POST /projects/{id}/import`).
    /// The body is built and validated on the frontend (it regroups the flat
    /// CSK export into `{ columns: [...] }`), so we pass it through opaque as a
    /// `serde_json::Value`. NOT idempotent — re-sending duplicates tasks — so we
    /// deliberately send NO idempotency key.
    pub async fn import_tasks(
        &self,
        project_id: &str,
        body: serde_json::Value,
    ) -> Result<ImportResult, TrelloError> {
        let req = self
            .request(Method::POST, &format!("projects/{project_id}/import"))?
            .json(&body);
        let (result, _) = self.send::<ImportResult>(req, None).await?;
        Ok(result)
    }
}

/// Pull idempotency / partial-complete flags from response headers.
fn extract_meta(resp: &reqwest::Response) -> ResponseMeta {
    let idempotent_replay = resp
        .headers()
        .get(REPLAY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let partial_complete = resp
        .headers()
        .get(PARTIAL_COMPLETE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    ResponseMeta {
        idempotent_replay,
        partial_complete,
    }
}

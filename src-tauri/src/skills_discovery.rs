//! Skill discovery (slice 1 of the "suggested skills" feature).
//!
//! Surfaces new skills published on skills.sh that match the user's actual
//! stack, ranked by a trust-weighted relevance score. This slice only
//! DISCOVERS and RANKS — it does not fetch snapshots, audit, or install.
//! Those are slices 2 and 3. Nothing here ever executes skill content; the
//! skills.sh API returns metadata only.
//!
//! Relevance is hybrid: keywords auto-derived from project manifests are
//! unioned with the user's own added keywords, minus their excluded ones
//! (the add/exclude lists live in the frontend and arrive as arguments).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// A skill candidate surfaced from skills.sh, with the relevance signal
/// attached. `audit` is intentionally absent in slice 1 — the frontend
/// renders an "audit pending" state and slice 2 fills it in.
#[derive(Debug, Clone, Serialize)]
pub struct SkillCandidate {
    /// Fully-qualified id, e.g. "vercel-labs/agent-skills/react-best-practices".
    pub id: String,
    /// Short skill id within the source repo.
    pub skill_id: String,
    /// Display name.
    pub name: String,
    /// "owner/repo" — the GitHub source used by slice 2 to pin a snapshot.
    pub source: String,
    /// Total install count from skills.sh (a trust signal, not a guarantee).
    pub installs: u64,
    /// Which of the user's keywords this candidate matched — shown as chips
    /// so the suggestion is explainable ("why am I seeing this?").
    pub matched_keywords: Vec<String>,
    /// log10(installs) * matched_keywords — see `score_candidate`.
    pub score: f64,
    /// Link to the skills.sh detail page.
    pub url: String,
}

/// Raw shape of one item in skills.sh `/api/search` responses.
#[derive(Debug, Deserialize)]
struct ApiSkill {
    id: String,
    #[serde(rename = "skillId")]
    skill_id: String,
    name: String,
    installs: u64,
    source: String,
}

#[derive(Debug, Deserialize)]
struct ApiSearchResponse {
    #[serde(default)]
    skills: Vec<ApiSkill>,
}

const SKILLS_SH_SEARCH: &str = "https://skills.sh/api/search";
/// Skills below this install count are filtered out — the floor matches the
/// find-skills skill's own "be cautious under 100" guidance.
const MIN_INSTALLS: u64 = 100;
/// Cap candidates returned to the UI so a broad keyword set can't flood it.
const MAX_CANDIDATES: usize = 12;
/// Cap keywords queried so a sprawling monorepo can't fan out to dozens of
/// HTTP calls.
const MAX_KEYWORDS: usize = 16;

/// Map a dependency / manifest token to the stack keyword we'd search for.
/// Kept deliberately small and high-signal — false keywords pollute results
/// worse than missing ones.
fn manifest_keywords_for(file_name: &str, contents: &str) -> Vec<String> {
    let lc = contents.to_lowercase();
    let mut kws: BTreeSet<String> = BTreeSet::new();
    let mut add = |k: &str| {
        kws.insert(k.to_string());
    };

    match file_name {
        "package.json" => {
            add("javascript");
            if lc.contains("\"react\"") || lc.contains("react-dom") {
                add("react");
            }
            if lc.contains("\"next\"") {
                add("nextjs");
            }
            if lc.contains("\"vue\"") {
                add("vue");
            }
            if lc.contains("svelte") {
                add("svelte");
            }
            if lc.contains("astro") {
                add("astro");
            }
            if lc.contains("tailwind") {
                add("tailwind");
            }
            if lc.contains("typescript") || lc.contains("\"tsconfig") {
                add("typescript");
            }
            if lc.contains("@tauri-apps") {
                add("tauri");
            }
            if lc.contains("vitest") || lc.contains("jest") || lc.contains("playwright") {
                add("testing");
            }
        }
        "Cargo.toml" => {
            add("rust");
            if lc.contains("tauri") {
                add("tauri");
            }
            if lc.contains("axum") || lc.contains("actix") || lc.contains("rocket") {
                add("backend");
            }
        }
        "pyproject.toml" | "requirements.txt" => {
            add("python");
            if lc.contains("django") {
                add("django");
            }
            if lc.contains("fastapi") {
                add("fastapi");
            }
            if lc.contains("pandas") || lc.contains("numpy") {
                add("data");
            }
        }
        "go.mod" => add("go"),
        "composer.json" => {
            add("php");
            if lc.contains("laravel") {
                add("laravel");
            }
        }
        "Gemfile" => add("ruby"),
        "pubspec.yaml" => add("flutter"),
        "mix.exs" => add("elixir"),
        _ => {}
    }
    kws.into_iter().collect()
}

/// The manifest files we read to derive keywords. Subset of the broader
/// project-marker list — only the ones whose CONTENTS carry stack signal.
const KEYWORD_MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "composer.json",
    "Gemfile",
    "pubspec.yaml",
    "mix.exs",
];

/// Largest prefix of `s` that is at most `cap` bytes AND ends on a char
/// boundary. Slicing a `&str` at a raw byte offset panics when the offset
/// lands mid-codepoint, and real manifests do contain emoji / non-ASCII
/// (descriptions, author names).
fn utf8_prefix(s: &str, cap: usize) -> &str {
    if s.len() <= cap {
        return s;
    }
    let mut end = cap;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Read manifests in `dir` (and one level of subdirs, for monorepos) and
/// collect stack keywords. Bounded: reads at most the known manifest files,
/// never descends deeper than one level.
fn keywords_from_project_dir(dir: &Path) -> BTreeSet<String> {
    let mut kws: BTreeSet<String> = BTreeSet::new();
    let mut scan_one = |d: &Path| {
        for manifest in KEYWORD_MANIFESTS {
            let p = d.join(manifest);
            if let Ok(contents) = fs::read_to_string(&p) {
                // Cap read size defensively — a pathological manifest
                // shouldn't blow up the scan.
                let slice = utf8_prefix(&contents, 64 * 1024);
                for k in manifest_keywords_for(manifest, slice) {
                    kws.insert(k);
                }
            }
        }
    };
    scan_one(dir);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten().take(64) {
            let p = entry.path();
            if p.is_dir() {
                scan_one(&p);
            }
        }
    }
    kws
}

/// Derive auto keywords from a set of active project directories plus the
/// names of already-installed skills (a user with `trading-filter-audit`
/// installed probably wants more trading skills). Caller supplies the dirs
/// (from the existing project scan) and installed-skill names so this stays
/// pure and testable.
pub fn derive_keywords(project_dirs: &[String], installed_skill_names: &[String]) -> Vec<String> {
    let mut kws: BTreeSet<String> = BTreeSet::new();
    for dir in project_dirs {
        for k in keywords_from_project_dir(Path::new(dir)) {
            kws.insert(k);
        }
    }
    // Installed skill names often encode a domain ("trading-filter-audit" →
    // "trading", "supabase-postgres-best-practices" → "supabase",
    // "postgres"). Split on separators and keep tokens long enough to be
    // meaningful, dropping generic filler.
    const FILLER: &[&str] = &[
        "best", "practices", "skill", "skills", "audit", "guidelines", "pro", "max", "agent",
        "the", "and", "for", "with",
    ];
    for name in installed_skill_names {
        for tok in name.split(|c: char| c == '-' || c == '_' || c == ' ') {
            let t = tok.trim().to_lowercase();
            if t.len() >= 4 && !FILLER.contains(&t.as_str()) {
                kws.insert(t);
            }
        }
    }
    kws.into_iter().collect()
}

/// Trust-weighted relevance. log10 dampens raw install counts so a 400K
/// install giant that matches one keyword can't bury a 2K-install skill that
/// matches three of the user's keywords. installs is clamped to >=10 so the
/// log is always positive.
fn score_candidate(installs: u64, match_count: usize) -> f64 {
    let installs = installs.max(10) as f64;
    installs.log10() * (match_count as f64)
}

/// Query skills.sh for one keyword. Network errors are non-fatal (returns an
/// empty vec) so one slow keyword can't fail the whole discovery.
async fn search_one(client: &reqwest::Client, keyword: &str) -> Vec<ApiSkill> {
    let resp = client
        .get(SKILLS_SH_SEARCH)
        .query(&[("q", keyword)])
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => r
            .json::<ApiSearchResponse>()
            .await
            .map(|b| b.skills)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Discover and rank skill candidates.
///
/// - `keywords`: the effective keyword set (auto ∪ added − excluded), already
///   resolved by the caller.
/// - `installed_ids`: fully-qualified ids of skills the user already has, so
///   we never suggest something they've installed.
/// - `hidden_ids`: candidates the user explicitly dismissed.
///
/// Returns up to `MAX_CANDIDATES`, ranked by `score` descending.
pub async fn discover(
    keywords: &[String],
    installed_ids: &BTreeSet<String>,
    hidden_ids: &BTreeSet<String>,
) -> Result<Vec<SkillCandidate>, String> {
    let kws: Vec<String> = keywords
        .iter()
        .map(|k| k.trim().to_lowercase())
        .filter(|k| !k.is_empty())
        .take(MAX_KEYWORDS)
        .collect();
    if kws.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::builder()
        .user_agent("claude-startup-kit/skill-discovery")
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // Fan the keyword searches out concurrently — sequential awaits made the
    // worst case MAX_KEYWORDS × 12s timeout. reqwest::Client clones cheaply
    // (it's an Arc) and 16 in-flight requests is well within polite bounds.
    let mut handles = Vec::with_capacity(kws.len());
    for kw in kws.iter().cloned() {
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            let skills = search_one(&client, &kw).await;
            (kw, skills)
        }));
    }

    // Accumulate raw hits per skill id, tracking which keywords matched.
    let mut hits: BTreeMap<String, (ApiSkill, BTreeSet<String>)> = BTreeMap::new();
    for handle in handles {
        // A panicked search task just drops that keyword's results.
        let Ok((kw, skills)) = handle.await else {
            continue;
        };
        for s in skills {
            let entry = hits.entry(s.id.clone());
            match entry {
                std::collections::btree_map::Entry::Occupied(mut o) => {
                    o.get_mut().1.insert(kw.clone());
                }
                std::collections::btree_map::Entry::Vacant(v) => {
                    let mut set = BTreeSet::new();
                    set.insert(kw.clone());
                    v.insert((s, set));
                }
            }
        }
    }

    let mut candidates: Vec<SkillCandidate> = hits
        .into_values()
        .filter(|(s, _)| s.installs >= MIN_INSTALLS)
        .filter(|(s, _)| !installed_ids.contains(&s.id))
        .filter(|(s, _)| !hidden_ids.contains(&s.id))
        .map(|(s, matched)| {
            let matched_keywords: Vec<String> = matched.into_iter().collect();
            let score = score_candidate(s.installs, matched_keywords.len());
            let url = format!("https://skills.sh/{}", s.id);
            SkillCandidate {
                id: s.id,
                skill_id: s.skill_id,
                name: s.name,
                source: s.source,
                installs: s.installs,
                matched_keywords,
                score,
                url,
            }
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.installs.cmp(&a.installs))
    });
    candidates.truncate(MAX_CANDIDATES);
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_react_and_ts() {
        let pkg = r#"{ "dependencies": { "react": "^19", "typescript": "^5" } }"#;
        let k = manifest_keywords_for("package.json", pkg);
        assert!(k.contains(&"react".to_string()));
        assert!(k.contains(&"typescript".to_string()));
        assert!(k.contains(&"javascript".to_string()));
    }

    #[test]
    fn manifest_cargo_tauri() {
        let cargo = "[dependencies]\ntauri = \"2\"\ntokio = \"1\"";
        let k = manifest_keywords_for("Cargo.toml", cargo);
        assert!(k.contains(&"rust".to_string()));
        assert!(k.contains(&"tauri".to_string()));
    }

    #[test]
    fn installed_names_yield_domain_keywords() {
        let kws = derive_keywords(
            &[],
            &[
                "trading-filter-audit".to_string(),
                "supabase-postgres-best-practices".to_string(),
            ],
        );
        assert!(kws.contains(&"trading".to_string()));
        assert!(kws.contains(&"filter".to_string()));
        assert!(kws.contains(&"supabase".to_string()));
        assert!(kws.contains(&"postgres".to_string()));
        // Filler dropped.
        assert!(!kws.contains(&"best".to_string()));
        assert!(!kws.contains(&"audit".to_string()));
    }

    #[test]
    fn score_dampens_giant_single_match() {
        // 2K installs matching 3 keywords beats 400K matching 1.
        let small = score_candidate(2_000, 3);
        let giant = score_candidate(400_000, 1);
        assert!(small > giant, "small={small} giant={giant}");
    }

    #[test]
    fn utf8_prefix_never_splits_codepoints() {
        // "ñ" is 2 bytes; a cap landing mid-codepoint must back off.
        let s = "añb";
        assert_eq!(utf8_prefix(s, 2), "a"); // byte 2 is inside 'ñ'
        assert_eq!(utf8_prefix(s, 3), "añ");
        assert_eq!(utf8_prefix(s, 100), s); // cap beyond len → whole str
        // 4-byte emoji at the boundary.
        let e = "ab🎉cd";
        assert_eq!(utf8_prefix(e, 3), "ab");
        assert_eq!(utf8_prefix(e, 6), "ab🎉");
    }
}

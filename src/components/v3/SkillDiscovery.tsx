import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Compass, ExternalLink, Plus, RefreshCw, X } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

// Slice 1 of the "suggested skills" feature: discover + rank only. No fetch,
// audit, or install happens here — those land in slices 2 and 3. The Rust
// `skills_discover` command returns metadata from skills.sh; nothing is
// executed.
interface SkillCandidate {
  id: string;
  skill_id: string;
  name: string;
  source: string;
  installs: number;
  matched_keywords: string[];
  score: number;
  url: string;
}

// localStorage keys — added/excluded keywords and dismissed candidates
// persist across sessions so the hybrid keyword set and the user's hide
// choices stick.
const LS_ADDED = "csk-skill-kw-added";
const LS_EXCLUDED = "csk-skill-kw-excluded";
const LS_HIDDEN = "csk-skill-hidden-ids";

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage full / disabled — non-fatal, just won't persist */
  }
}

export function SkillDiscovery() {
  const { t } = useT();
  const [autoKeywords, setAutoKeywords] = useState<string[]>([]);
  const [added, setAdded] = useState<string[]>(() => readList(LS_ADDED));
  const [excluded, setExcluded] = useState<string[]>(() => readList(LS_EXCLUDED));
  const [hidden, setHidden] = useState<string[]>(() => readList(LS_HIDDEN));
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState("");

  // Effective keyword set: (auto ∪ added) − excluded, deduped, lowercased.
  const effectiveKeywords = useMemo(() => {
    const ex = new Set(excluded.map((k) => k.toLowerCase()));
    const set = new Set<string>();
    for (const k of [...autoKeywords, ...added]) {
      const lk = k.trim().toLowerCase();
      if (lk && !ex.has(lk)) set.add(lk);
    }
    return [...set].sort();
  }, [autoKeywords, added, excluded]);

  const runDiscovery = useCallback(
    async (keywords: string[], hiddenIds: string[]) => {
      if (!IS_TAURI || keywords.length === 0) {
        setCandidates([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const found = await invoke<SkillCandidate[]>("skills_discover", {
          keywords,
          hiddenIds,
        });
        setCandidates(found);
      } catch (e) {
        setError(friendlyErrorEn(e));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // On mount: derive auto keywords from the stack, then discover.
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<string[]>("skills_stack_keywords")
      .then((kws) => {
        if (cancelled) return;
        setAutoKeywords(kws);
      })
      .catch(() => {
        /* keyword derivation is best-effort; user can still add manually */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-run discovery whenever the effective keyword set or hidden list
  // changes (debounced lightly so rapid chip edits don't spam the API).
  useEffect(() => {
    if (!IS_TAURI) return;
    const timer = setTimeout(() => {
      void runDiscovery(effectiveKeywords, hidden);
    }, 400);
    return () => clearTimeout(timer);
  }, [effectiveKeywords, hidden, runDiscovery]);

  const addKeyword = () => {
    const k = newKeyword.trim().toLowerCase();
    if (!k) return;
    setNewKeyword("");
    // Adding a keyword that was excluded un-excludes it; otherwise append.
    if (excluded.includes(k)) {
      const next = excluded.filter((x) => x !== k);
      setExcluded(next);
      writeList(LS_EXCLUDED, next);
      return;
    }
    if (!added.includes(k) && !autoKeywords.includes(k)) {
      const next = [...added, k];
      setAdded(next);
      writeList(LS_ADDED, next);
    }
  };

  // Removing a chip: if it's user-added, drop it from added; if it's
  // auto-derived, add it to the excluded list so it stays gone.
  const removeKeyword = (k: string) => {
    if (added.includes(k)) {
      const next = added.filter((x) => x !== k);
      setAdded(next);
      writeList(LS_ADDED, next);
    } else {
      const next = [...new Set([...excluded, k])];
      setExcluded(next);
      writeList(LS_EXCLUDED, next);
    }
  };

  const hideCandidate = (id: string) => {
    const next = [...new Set([...hidden, id])];
    setHidden(next);
    writeList(LS_HIDDEN, next);
    setCandidates((prev) => prev.filter((c) => c.id !== id));
  };

  const openUrl = (url: string) => {
    if (!IS_TAURI) return;
    void invoke("open_url", { url }).catch(() => {
      /* best-effort */
    });
  };

  return (
    <article className="v3-card v3-skill-discovery">
      <header className="v3-card-head">
        <h2 className="v3-card-title">
          <Compass size={15} strokeWidth={2} className="v3-card-title-icon" />
          {t("discovery.title")}
        </h2>
        <button
          type="button"
          className="v3-icon-btn"
          onClick={() => void runDiscovery(effectiveKeywords, hidden)}
          disabled={loading}
          title={t("discovery.refresh")}
          aria-label={t("discovery.refresh")}
        >
          <RefreshCw size={14} strokeWidth={2} className={loading ? "v3-spin" : ""} />
        </button>
      </header>

      <p className="v3-subtitle v3-discovery-lead">{t("discovery.lead")}</p>

      {/* Keyword chips — the explainable, editable relevance signal. */}
      <div className="v3-discovery-keywords">
        {effectiveKeywords.map((k) => (
          <span key={k} className="v3-kw-chip">
            {k}
            <button
              type="button"
              className="v3-kw-chip-x"
              onClick={() => removeKeyword(k)}
              aria-label={t("discovery.remove_keyword", { kw: k })}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <span className="v3-kw-add">
          <input
            className="v3-kw-add-input"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addKeyword();
            }}
            placeholder={t("discovery.add_keyword")}
            aria-label={t("discovery.add_keyword")}
          />
          <button
            type="button"
            className="v3-kw-add-btn"
            onClick={addKeyword}
            disabled={!newKeyword.trim()}
            aria-label={t("discovery.add_keyword")}
          >
            <Plus size={12} strokeWidth={2.5} />
          </button>
        </span>
      </div>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading && candidates.length === 0 ? (
        <div className="v3-empty">{t("discovery.searching")}</div>
      ) : effectiveKeywords.length === 0 ? (
        <div className="v3-empty">{t("discovery.no_keywords")}</div>
      ) : candidates.length === 0 ? (
        <div className="v3-empty">{t("discovery.no_results")}</div>
      ) : (
        <ul className="v3-list v3-discovery-list">
          {candidates.map((c) => (
            <li key={c.id} className="v3-discovery-row">
              <div className="v3-discovery-row-main">
                <div className="v3-discovery-row-head">
                  <span className="v3-discovery-name">{c.name}</span>
                  <span className="v3-discovery-source">{c.source}</span>
                </div>
                <div className="v3-discovery-meta">
                  <span className="v3-discovery-installs">
                    {t("discovery.installs", { n: c.installs.toLocaleString() })}
                  </span>
                  <span className="v3-discovery-matches">
                    {c.matched_keywords.map((k) => (
                      <span key={k} className="v3-kw-chip v3-kw-chip-match">
                        {k}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
              <div className="v3-discovery-row-actions">
                {/* Audit (slice 2) and Install (slice 3) buttons land here.
                    For now we surface the skills.sh page and a hide action. */}
                <button
                  type="button"
                  className="v3-btn-ghost v3-discovery-view"
                  onClick={() => openUrl(c.url)}
                  title={t("discovery.view_hint")}
                >
                  <ExternalLink size={12} strokeWidth={2} />
                  {t("discovery.view")}
                </button>
                <button
                  type="button"
                  className="v3-icon-btn v3-discovery-hide"
                  onClick={() => hideCandidate(c.id)}
                  title={t("discovery.hide")}
                  aria-label={t("discovery.hide")}
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

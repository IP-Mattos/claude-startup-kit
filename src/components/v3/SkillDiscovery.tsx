import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  ExternalLink,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
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

// Verdict returned by the slice-2 `skill_audit` command. Mirrors the Rust
// AuditVerdict shape (serde). The skill content itself is never returned —
// only the verdict + findings.
interface StaticFinding {
  severity: "Blocking" | "Warning";
  rule: string;
  detail: string;
  file: string;
  line: number;
  snippet: string;
}
interface LlmFinding {
  severity: string;
  title: string;
  why: string;
  quote: string;
}
interface AuditVerdict {
  sha: string;
  source: string;
  skill_id: string;
  static_report: { passed: boolean; findings: StaticFinding[] };
  llm: { verdict: string; summary: string; findings: LlmFinding[] } | null;
  verdict: "approved" | "warnings" | "rejected" | string;
  audited_at: string;
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
  // Audit state, keyed by candidate id. `auditing` tracks the in-flight id;
  // `audits` caches verdicts; `auditError` holds a per-candidate failure.
  const [auditing, setAuditing] = useState<string | null>(null);
  const [audits, setAudits] = useState<Record<string, AuditVerdict>>({});
  const [auditErrors, setAuditErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  // On mount: derive auto keywords from the stack. Setting autoKeywords
  // changes effectiveKeywords, which triggers the debounced discovery effect
  // below — do NOT call runDiscovery() here directly, or it would run with a
  // stale (empty) `hidden` and skip the user's dismissals on first load.
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

  // Run the slice-2 audit for one candidate. The verdict is cached so the
  // user can collapse/expand without re-auditing.
  const runAudit = async (c: SkillCandidate) => {
    if (!IS_TAURI || auditing) return;
    setAuditing(c.id);
    setAuditErrors((prev) => {
      const next = { ...prev };
      delete next[c.id];
      return next;
    });
    try {
      const verdict = await invoke<AuditVerdict>("skill_audit", {
        source: c.source,
        skillId: c.skill_id,
      });
      setAudits((prev) => ({ ...prev, [c.id]: verdict }));
      setExpanded((prev) => ({ ...prev, [c.id]: true }));
    } catch (e) {
      setAuditErrors((prev) => ({ ...prev, [c.id]: friendlyErrorEn(e) }));
    } finally {
      setAuditing(null);
    }
  };

  return (
    <article className="v3-card v3-skill-discovery" aria-busy={loading}>
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
            aria-label={t("discovery.add_keyword_btn")}
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
          {candidates.map((c) => {
            const audit = audits[c.id];
            const isExpanded = expanded[c.id];
            return (
              <li key={c.id} className="v3-discovery-row-wrap">
                <div className="v3-discovery-row">
                  <div className="v3-discovery-row-main">
                    <div className="v3-discovery-row-head">
                      <span className="v3-discovery-name">{c.name}</span>
                      <span className="v3-discovery-source">{c.source}</span>
                      {audit && <VerdictBadge verdict={audit.verdict} t={t} />}
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
                    {audit ? (
                      <button
                        type="button"
                        className="v3-btn-ghost v3-discovery-view"
                        onClick={() =>
                          setExpanded((p) => ({ ...p, [c.id]: !p[c.id] }))
                        }
                      >
                        <Shield size={12} strokeWidth={2} />
                        {isExpanded ? t("discovery.hide_audit") : t("discovery.show_audit")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="v3-btn-primary v3-discovery-audit"
                        onClick={() => runAudit(c)}
                        disabled={auditing !== null}
                        title={t("discovery.audit_hint")}
                      >
                        <Shield size={12} strokeWidth={2} />
                        {auditing === c.id ? t("discovery.auditing") : t("discovery.audit")}
                      </button>
                    )}
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
                </div>
                {auditErrors[c.id] && (
                  <div className="v3-error v3-discovery-audit-error" role="alert">
                    {auditErrors[c.id]}
                  </div>
                )}
                {audit && isExpanded && <AuditPanel audit={audit} t={t} />}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

type TFn = (key: any, vars?: Record<string, string | number>) => string;

// Small colored pill summarizing the final verdict.
function VerdictBadge({ verdict, t }: { verdict: string; t: TFn }) {
  const map: Record<string, { cls: string; icon: ReactNode; key: string }> = {
    approved: {
      cls: "v3-verdict-approved",
      icon: <ShieldCheck size={11} strokeWidth={2.4} />,
      key: "discovery.verdict_approved",
    },
    warnings: {
      cls: "v3-verdict-warnings",
      icon: <ShieldAlert size={11} strokeWidth={2.4} />,
      key: "discovery.verdict_warnings",
    },
    rejected: {
      cls: "v3-verdict-rejected",
      icon: <XCircle size={11} strokeWidth={2.4} />,
      key: "discovery.verdict_rejected",
    },
  };
  const v = map[verdict] ?? map.warnings;
  return (
    <span className={"v3-verdict-badge " + v.cls}>
      {v.icon}
      {t(v.key)}
    </span>
  );
}

// Expanded audit detail: static findings + LLM summary/findings. Install
// (slice 3) will hook in here, gated on verdict !== "rejected".
function AuditPanel({ audit, t }: { audit: AuditVerdict; t: TFn }) {
  const sf = audit.static_report.findings;
  const blocking = sf.filter((f) => f.severity === "Blocking");
  const warns = sf.filter((f) => f.severity === "Warning");
  return (
    <div className="v3-audit-panel">
      <div className="v3-audit-meta">
        {t("discovery.audited_sha", { sha: audit.sha.slice(0, 7) })}
      </div>

      {/* Static layer */}
      <div className="v3-audit-layer">
        <div className="v3-audit-layer-head">
          {audit.static_report.passed ? (
            <CheckCircle2 size={13} strokeWidth={2} className="v3-ok-icon" />
          ) : (
            <XCircle size={13} strokeWidth={2} className="v3-crit-icon" />
          )}
          {t("discovery.static_layer")}
        </div>
        {sf.length === 0 ? (
          <p className="v3-audit-clean">{t("discovery.static_clean")}</p>
        ) : (
          <ul className="v3-audit-findings">
            {[...blocking, ...warns].map((f, i) => (
              <li
                key={i}
                className={
                  "v3-audit-finding " +
                  (f.severity === "Blocking" ? "is-blocking" : "is-warning")
                }
              >
                <span className="v3-audit-finding-head">
                  {f.severity === "Blocking" ? (
                    <XCircle size={11} strokeWidth={2.4} />
                  ) : (
                    <AlertTriangle size={11} strokeWidth={2.4} />
                  )}
                  <code>{f.rule}</code>
                  <span className="v3-audit-finding-loc">
                    {f.file}:{f.line}
                  </span>
                </span>
                <span className="v3-audit-finding-detail">{f.detail}</span>
                {f.snippet && <code className="v3-audit-snippet">{f.snippet}</code>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* LLM layer */}
      <div className="v3-audit-layer">
        <div className="v3-audit-layer-head">
          <Shield size={13} strokeWidth={2} />
          {t("discovery.llm_layer")}
        </div>
        {audit.llm ? (
          <>
            <p className="v3-audit-llm-summary">{audit.llm.summary}</p>
            {audit.llm.findings.length > 0 && (
              <ul className="v3-audit-findings">
                {audit.llm.findings.map((f, i) => (
                  <li
                    key={i}
                    className={
                      "v3-audit-finding " +
                      (f.severity === "critical" ? "is-blocking" : "is-warning")
                    }
                  >
                    <span className="v3-audit-finding-head">
                      <code>{f.severity}</code>
                      <span>{f.title}</span>
                    </span>
                    {f.why && <span className="v3-audit-finding-detail">{f.why}</span>}
                    {f.quote && <code className="v3-audit-snippet">{f.quote}</code>}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="v3-audit-clean">{t("discovery.llm_unavailable")}</p>
        )}
      </div>
    </div>
  );
}

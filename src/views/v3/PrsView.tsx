import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, GitPullRequest, Search } from "lucide-react";
import type { GhPullRequest } from "../../types";
import { friendlyErrorEn, prNumberFromUrl } from "../../lib/format";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { plural, useT } from "../../lib/i18n";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function PrsView() {
  const { t } = useT();
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<GhPullRequest[]>("github_review_queue", { limit: 50 })
      .then((res) => {
        if (!cancelled) setPrs(res);
      })
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const debouncedQuery = useDebouncedValue(query);
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.repository.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q)
    );
  }, [prs, debouncedQuery]);

  const openUrl = (url: string) => {
    if (!IS_TAURI) {
      window.open(url, "_blank");
      return;
    }
    invoke("open_url", { url }).catch((e) => setError(friendlyErrorEn(e)));
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("prs.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("common.loading")
              : plural(t, prs.length, "prs.summary_one", "prs.summary_other")}
          </p>
        </div>
      </header>

      <div className="v3-search">
        <Search size={14} strokeWidth={2} />
        <input
          type="text"
          placeholder={t("prs.search_placeholder")}
          aria-label={t("prs.search_aria")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="v3-empty">{t("prs.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="v3-empty">
          {prs.length === 0
            ? t("prs.inbox_zero")
            : t("prs.empty_search", { q: query })}
        </div>
      ) : (
        <div className="v3-list">
          {filtered.map((pr) => (
            <article
              key={pr.url}
              className="v3-row v3-row-pr"
              onClick={() => openUrl(pr.url)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openUrl(pr.url);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={t("prs.open_label", { title: pr.title })}
            >
              <div className="v3-row-icon" aria-hidden="true">
                <GitPullRequest size={16} strokeWidth={2} />
              </div>
              <div className="v3-row-body">
                <div className="v3-row-title">{pr.title}</div>
                <div className="v3-row-meta">
                  {(() => {
                    const num = prNumberFromUrl(pr.url);
                    return (
                      <>
                        {num !== null && <span>#{num}</span>}
                        <span className="v3-row-dot" aria-hidden="true">
                          ·
                        </span>
                        <span>{pr.repository}</span>
                        <span className="v3-row-dot" aria-hidden="true">
                          ·
                        </span>
                        <span>{t("prs.by_author", { author: pr.author })}</span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="v3-row-end">
                <span className="v3-pr-pill v3-pr-pill-open">{t("prs.open")}</span>
                <ExternalLink size={14} strokeWidth={2} className="v3-row-extra" />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertOctagon, AlertTriangle, Check, Info, RefreshCw } from "lucide-react";
import type { AuditFinding } from "../../types";
import { friendlyErrorEn } from "../../lib/format";
import { parseAuditFindings } from "../../lib/audit";
import { plural, useT } from "../../lib/i18n";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function AuditView() {
  const { t } = useT();
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "CRIT" | "WARN" | "INFO">("all");
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<unknown>("run_audit")
      .then(parseAuditFindings)
      .then((res) => !cancelled && setFindings(res))
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const grouped = useMemo(() => {
    const filtered =
      filter === "all" ? findings : findings.filter((f) => f.level === filter);
    const map = new Map<string, AuditFinding[]>();
    for (const f of filtered) {
      const arr = map.get(f.category) ?? [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return Array.from(map.entries());
  }, [findings, filter]);

  const counts = useMemo(() => {
    return {
      crit: findings.filter((f) => f.level === "CRIT").length,
      warn: findings.filter((f) => f.level === "WARN").length,
      info: findings.filter((f) => f.level === "INFO").length,
      all: findings.length,
    };
  }, [findings]);

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("audit.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("audit.running")
              : plural(t, findings.length, "audit.summary_one", "audit.summary_other")}
          </p>
        </div>
        <div className="v3-view-tools">
          <button
            className="v3-btn-ghost v3-btn-sm"
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            <RefreshCw size={13} strokeWidth={2} />
            {t("audit.rerun")}
          </button>
        </div>
      </header>

      <div className="v3-filter-row">
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={t("audit.filter_all", { n: counts.all })}
        />
        <FilterChip
          active={filter === "CRIT"}
          onClick={() => setFilter("CRIT")}
          label={t("audit.filter_critical", { n: counts.crit })}
          tint="crit"
        />
        <FilterChip
          active={filter === "WARN"}
          onClick={() => setFilter("WARN")}
          label={t("audit.filter_warning", { n: counts.warn })}
          tint="warn"
        />
        <FilterChip
          active={filter === "INFO"}
          onClick={() => setFilter("INFO")}
          label={t("audit.filter_info", { n: counts.info })}
          tint="info"
        />
      </div>

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("audit.running")}</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">
          {findings.length === 0 ? t("audit.clean") : t("audit.no_match")}
        </div>
      ) : (
        <div className="v3-audit-groups">
          {grouped.map(([category, items]) => (
            <article key={category} className="v3-card">
              <header className="v3-card-head">
                <h2 className="v3-card-title">{category}</h2>
                <span className="v3-pill v3-pill-soft">{items.length}</span>
              </header>
              <div className="v3-finding-list">
                {items.map((f, i) => (
                  <FindingRow key={`${category}-${i}`} finding={f} />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tint?: "crit" | "warn" | "info";
}) {
  return (
    <button
      className={
        "v3-chip" +
        (active ? " active" : "") +
        (tint ? ` v3-chip-${tint}` : "")
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FindingRow({ finding }: { finding: AuditFinding }) {
  const Icon =
    finding.level === "CRIT"
      ? AlertOctagon
      : finding.level === "WARN"
      ? AlertTriangle
      : finding.level === "OK"
      ? Check
      : Info;
  const tint = finding.level.toLowerCase();
  return (
    <div className={`v3-finding v3-finding-${tint}`}>
      <span className={`v3-finding-icon v3-finding-icon-${tint}`} aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>
      <div className="v3-finding-body">
        <div className="v3-finding-title">{finding.title}</div>
        <div className="v3-finding-detail">{finding.detail}</div>
      </div>
      <span className={`v3-level-pill v3-level-${tint}`}>{finding.level}</span>
    </div>
  );
}

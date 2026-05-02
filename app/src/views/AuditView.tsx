import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { AuditFinding } from "../types";
import { friendlyError } from "../lib/format";
import { AuditFindingRow } from "../components/AuditFindingRow";

export type AuditViewProps = {
  onCount: (n: number) => void;
  refreshNonce: number;
};

export default function AuditView({ onCount, refreshNonce }: AuditViewProps) {
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await invoke<AuditFinding[]>("run_audit");
        if (!cancelled) setFindings(res);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  useEffect(() => {
    onCount(findings.length);
  }, [findings.length, onCount]);

  const counts = useMemo(
    () => ({
      crit: findings.filter((f) => f.level === "CRIT").length,
      warn: findings.filter((f) => f.level === "WARN").length,
      info: findings.filter((f) => f.level === "INFO").length,
    }),
    [findings]
  );

  const { grouped, categories } = useMemo(() => {
    const g: Record<string, AuditFinding[]> = {};
    for (const f of findings) (g[f.category] ||= []).push(f);
    return { grouped: g, categories: Object.keys(g).sort() };
  }, [findings]);

  return (
    <>
      <div className="view-bar">
        <div className="audit-summary">
          <span className={"audit-pill crit" + (counts.crit ? " active" : "")}>
            <AlertTriangle size={12} /> {counts.crit} crit
          </span>
          <span className={"audit-pill warn" + (counts.warn ? " active" : "")}>
            <AlertTriangle size={12} /> {counts.warn} warn
          </span>
          <span className={"audit-pill info" + (counts.info ? " active" : "")}>
            <Info size={12} /> {counts.info} info
          </span>
        </div>
        <div className="filters">
          {loading && <RefreshCw size={14} className="spinning" />}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">
          <ShieldCheck size={32} className="state-icon spinning" />
          Ejecutando auditoría…
        </div>
      ) : findings.length === 0 ? (
        <div className="state">Sin hallazgos.</div>
      ) : (
        <div className="audit-categories">
          {categories.map((cat) => {
            const isCollapsed = collapsed[cat];
            const catCounts = {
              crit: grouped[cat].filter((f) => f.level === "CRIT").length,
              warn: grouped[cat].filter((f) => f.level === "WARN").length,
            };
            return (
              <section key={cat} className="audit-category">
                <button
                  className="audit-category-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{cat}</span>
                  <span className="audit-cat-count">
                    {grouped[cat].length}
                    {catCounts.crit > 0 && <span className="dot dot-crit" />}
                    {catCounts.warn > 0 && <span className="dot dot-warn" />}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul>
                    {grouped[cat].map((f, i) => (
                      <AuditFindingRow key={`${cat}-${i}`} finding={f} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

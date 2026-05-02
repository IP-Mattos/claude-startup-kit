import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import type { CleanupItem, CleanupResult } from "../types";
import { formatBytes, friendlyError } from "../lib/format";
import { CleanupItemRow } from "../components/CleanupItemRow";

export type CleanupViewProps = {
  onCount: (n: number) => void;
  refreshNonce: number;
};

export default function CleanupView({ onCount, refreshNonce }: CleanupViewProps) {
  const [plan, setPlan] = useState<CleanupItem[]>([]);
  const [olderThan, setOlderThan] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [localNonce, setLocalNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    (async () => {
      try {
        const res = await invoke<CleanupItem[]>("cleanup_plan", { olderThanDays: olderThan });
        if (!cancelled) setPlan(res);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [olderThan, refreshNonce, localNonce]);

  useEffect(() => {
    onCount(plan.length);
  }, [plan.length, onCount]);

  async function applyCleanup() {
    setError(null);
    try {
      const res = await invoke<CleanupResult>("cleanup_apply", {
        paths: plan.map((i) => i.path),
      });
      setResult(res);
      setConfirming(false);
      setLocalNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyError(e));
      setConfirming(false);
    }
  }

  const totalBytes = useMemo(() => plan.reduce((s, i) => s + i.bytes, 0), [plan]);
  const { grouped, cats } = useMemo(() => {
    const g: Record<string, CleanupItem[]> = {};
    for (const i of plan) (g[i.category] ||= []).push(i);
    return { grouped: g, cats: Object.keys(g).sort() };
  }, [plan]);

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <strong>{plan.length}</strong> items <span className="dim">·</span>
          <strong>{formatBytes(totalBytes)}</strong> recuperables
        </div>
        <div className="filters">
          <label className="select-wrap">
            <select
              value={olderThan}
              onChange={(e) => setOlderThan(Number(e.currentTarget.value))}
            >
              <option value={7}>Más viejos que 7 días</option>
              <option value={14}>Más viejos que 14 días</option>
              <option value={30}>Más viejos que 30 días</option>
              <option value={60}>Más viejos que 60 días</option>
              <option value={90}>Más viejos que 90 días</option>
            </select>
          </label>
          {loading && <RefreshCw size={14} className="spinning" />}
          {plan.length > 0 && !confirming && (
            <button className="danger" onClick={() => setConfirming(true)}>
              <Trash2 size={14} /> Borrar todo
            </button>
          )}
          {confirming && (
            <>
              <button className="ghost" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
              <button className="danger" onClick={applyCleanup}>
                Confirmar
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="result">
          <CheckCircle2 size={16} />
          Borrados <strong>{result.deleted}</strong> items, liberados{" "}
          <strong>{formatBytes(result.freed_bytes)}</strong>
          {result.failed > 0 && <span> · {result.failed} fallaron</span>}
        </div>
      )}

      {loading ? (
        <div className="state">Escaneando archivos…</div>
      ) : plan.length === 0 ? (
        <div className="state">
          <CheckCircle2 size={32} className="state-icon" />
          Nada para limpiar. Disco feliz.
        </div>
      ) : (
        <div className="cleanup-categories">
          {cats.map((cat) => {
            const items = grouped[cat];
            const sum = items.reduce((s, i) => s + i.bytes, 0);
            return (
              <section key={cat} className="cleanup-cat">
                <header>
                  <span className="cleanup-cat-name">{cat}</span>
                  <span className="cleanup-cat-meta">
                    {items.length} · {formatBytes(sum)}
                  </span>
                </header>
                <ul>
                  {items.slice(0, 8).map((i) => (
                    <CleanupItemRow key={i.path} item={i} />
                  ))}
                  {items.length > 8 && (
                    <li className="cleanup-more">… y {items.length - 8} más</li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

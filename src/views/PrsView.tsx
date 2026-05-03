import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitPullRequest, RefreshCw, ShieldCheck } from "lucide-react";
import type { GhPullRequest } from "../types";
import { friendlyError } from "../lib/format";
import { PrRow } from "../components/PrRow";

export type PrsViewProps = {
  onCount: (n: number) => void;
  refreshNonce: number;
};

export default function PrsView({ onCount, refreshNonce }: PrsViewProps) {
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await invoke<GhPullRequest[]>("github_review_queue", { limit: 20 });
        if (!cancelled) setPrs(res);
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
    onCount(prs.length);
  }, [prs.length, onCount]);

  async function open(url: string) {
    try {
      await invoke("open_url", { url });
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <strong>{prs.length}</strong> esperando tu review
        </div>
        <div className="filters">
          {loading && <RefreshCw size={14} className="spinning" />}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">
          <GitPullRequest size={32} className="state-icon" />
          Consultando GitHub…
        </div>
      ) : prs.length === 0 ? (
        <div className="state">
          <ShieldCheck size={32} className="state-icon" />
          No hay PRs esperando tu review. Inbox cero, hermano.
        </div>
      ) : (
        <ul className="prs">
          {prs.map((pr, i) => (
            <PrRow key={pr.url} pr={pr} index={i} onOpen={open} />
          ))}
        </ul>
      )}
    </>
  );
}

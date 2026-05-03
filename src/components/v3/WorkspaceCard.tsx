import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import type { WorkspaceSummary } from "../../v3/v3types";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Right-panel card: tooling state at a glance — skills usage + engram
// memory volume + version pins. Distinct from Overview (which carries
// project / pr / finding counts) — this card is about the *machine*.
export function WorkspaceCard() {
  const { t } = useT();
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<WorkspaceSummary>("workspace_summary")
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        /* card stays in skeleton state — non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const skillsPct = summary
    ? summary.skills_total === 0
      ? 0
      : Math.round((summary.skills_used / summary.skills_total) * 100)
    : 0;
  const dash = "—";

  return (
    <section className="v3-workspace-card">
      <header className="v3-workspace-head">
        <h3 className="v3-workspace-title">{t("workspace.title")}</h3>
      </header>
      <div className="v3-workspace-section">
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.skills")}</span>
          <span className="v3-workspace-row-value">
            {summary ? `${summary.skills_used} / ${summary.skills_total}` : dash}
          </span>
        </div>
        <div
          className="v3-workspace-bar-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={skillsPct}
          aria-label={t("workspace.skills")}
        >
          <div
            className="v3-workspace-bar-fill v3-workspace-bar-fill-accent"
            style={{ width: `${skillsPct}%` }}
          />
        </div>
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.engram")}</span>
          <span className="v3-workspace-row-value">
            {summary?.engram_observations != null
              ? t("workspace.engram_obs", { n: summary.engram_observations })
              : dash}
          </span>
        </div>
      </div>
      <div className="v3-workspace-divider" aria-hidden="true" />
      <div className="v3-workspace-section">
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.app")}</span>
          <span className="v3-workspace-row-value v3-workspace-version">
            v{summary?.app_version ?? dash}
          </span>
        </div>
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.gentle_ai")}</span>
          <span className="v3-workspace-row-value v3-workspace-version">
            {summary?.gentle_ai_version ? `v${summary.gentle_ai_version}` : dash}
          </span>
        </div>
      </div>
    </section>
  );
}

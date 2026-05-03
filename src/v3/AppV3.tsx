import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AuditFinding,
  GhPullRequest,
  Project,
  ProjectEnrichment,
} from "../types";
import { agoLabel, pickGreeting, projectName, friendlyErrorEn } from "../lib/format";
import type { V3Tab } from "./v3types";
import { CompanionWidget } from "../components/v3/CompanionWidget";
import { OverviewView } from "../components/v3/OverviewView";
import { Sidebar } from "../components/v3/Sidebar";
import { StatusBar } from "../components/v3/StatusBar";
import { Topbar } from "../components/v3/Topbar";
import { WorkspaceCard } from "../components/v3/WorkspaceCard";
import { KEYBOARD_TAB_ORDER } from "../constants/v3Nav";
import { parseAuditFindings } from "../lib/audit";
import { nextV3Theme, applyAndPersistV3Theme, readV3ThemeFromBody } from "../lib/themes";
import { enrichProjects } from "../lib/enrichProjects";
import { useUpdates } from "../lib/useUpdates";
import { useT } from "../lib/i18n";
import { ProjectsView } from "../views/v3/ProjectsView";
import { PrsView } from "../views/v3/PrsView";
import { AuditView } from "../views/v3/AuditView";
import { CleanupView } from "../views/v3/CleanupView";
import { ClaudeView } from "../views/v3/ClaudeView";
import { CompanionsView } from "../views/v3/CompanionsView";
import { SettingsView } from "../views/v3/SettingsView";
import { SyncView } from "../views/v3/SyncView";
import "./AppV3.css";

// Tauri APIs throw when loaded from a plain browser at localhost:1420
// (no __TAURI_INTERNALS__ global). Guard so AppV3 still renders for previews.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Topbar, Sidebar, OverviewView, CompanionWidget, WorkspaceCard, StatusBar
// moved to ../components/v3/. Nav catalogs in ../constants/v3Nav.ts.
// agoLabel + pickGreeting moved to ../lib/format.ts.



// agoLabel + pickGreeting moved to ../lib/format.ts
// KEYBOARD_TAB_ORDER moved to ../constants/v3Nav.ts

// ===== Root =====
export default function AppV3() {
  const [tab, setTab] = useState<V3Tab>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [lastScanTick, setLastScanTick] = useState(0); // forces re-render of "X ago"
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-source fetch errors — surfaced via the retry banner so backend
  // failures stop masquerading as empty states.
  const [fetchErrors, setFetchErrors] = useState<{ source: string; msg: string }[]>([]);

  // i18n hook — every helper that produces user-facing strings (greeting,
  // ago labels, headlines) takes `t` as a parameter so they stay pure.
  const { t } = useT();

  // Update channels (this app + gentle-ai). 24h cooldown is internal to the
  // hook; banners below render from the returned state.
  const updates = useUpdates();
  const [gentleAiApplying, setGentleAiApplying] = useState(false);
  const [gentleAiResult, setGentleAiResult] = useState<string | null>(null);
  const handleApplyGentleAi = async () => {
    setGentleAiApplying(true);
    setGentleAiResult(null);
    const after = await updates.applyGentleAi();
    setGentleAiApplying(false);
    setGentleAiResult(
      after ? t("banner.gentle_upgraded", { v: after }) : t("banner.update_failed")
    );
  };

  // Companion config — owned here so the right-panel widget updates live when
  // the user edits their companion in the Companions view. Persistence to
  // localStorage happens here too; CompanionsViewV3 just calls the setters.
  const [companionName, setCompanionName] = useState<string>(
    () => localStorage.getItem("csk-companion-name") ?? "Companion"
  );
  const [companionImage, setCompanionImage] = useState<string | null>(
    () => localStorage.getItem("csk-companion-image")
  );
  useEffect(() => {
    try {
      localStorage.setItem("csk-companion-name", companionName);
    } catch {
      /* ignore */
    }
  }, [companionName]);
  useEffect(() => {
    try {
      if (companionImage) localStorage.setItem("csk-companion-image", companionImage);
      else localStorage.removeItem("csk-companion-image");
    } catch {
      /* storage full — ignore */
    }
  }, [companionImage]);

  // Fetch all data on mount + refresh nonce.
  useEffect(() => {
    if (!IS_TAURI) {
      // Pure-browser preview: no Tauri APIs. Show empty state.
      setLoading(false);
      setLastScanAt(Date.now());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchErrors([]);
    (async () => {
      // Capture per-source errors as they happen; the banner reads from this.
      const errors: { source: string; msg: string }[] = [];
      const trap =
        <T,>(source: string, fallback: T) =>
        (e: unknown): T => {
          errors.push({ source, msg: friendlyErrorEn(e) });
          return fallback;
        };
      try {
        const [projectsP, knownP, findingsP, prsP] = [
          invoke<Project[]>("scan_projects", { windowDays: 14 }).catch(
            trap<Project[]>("Projects", [])
          ),
          invoke<string[]>("engram_known_projects").catch(
            trap<string[]>("Engram", [])
          ),
          invoke<unknown>("run_audit")
            .then(parseAuditFindings)
            .catch(trap<AuditFinding[]>("Audit", [])),
          invoke<GhPullRequest[]>("github_review_queue", { limit: 20 }).catch(
            trap<GhPullRequest[]>("Pull requests", [])
          ),
        ];
        const [projectsRes, known, findingsRes, prsRes] = await Promise.all([
          projectsP,
          knownP,
          findingsP,
          prsP,
        ]);
        if (cancelled) return;
        const enrichment: Record<string, ProjectEnrichment> = await enrichProjects(
          projectsRes,
          known
        ).catch(trap<Record<string, ProjectEnrichment>>("Project enrichment", {}));
        if (cancelled) return;
        const goalMap: Record<string, string | null> = {};
        for (const p of projectsRes) {
          goalMap[p.path] = enrichment[p.path]?.goal ?? null;
        }
        setProjects(projectsRes);
        setPrs(prsRes);
        setFindings(findingsRes);
        setGoals(goalMap);
        setLastScanAt(Date.now());
        setFetchErrors(errors);
      } catch (e) {
        console.error("AppV3 fetch failed", friendlyErrorEn(e));
        if (!cancelled) {
          setFetchErrors([
            ...errors,
            { source: "Workspace", msg: friendlyErrorEn(e) },
          ]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  // Tick for "X ago" updates every 30s.
  useEffect(() => {
    const id = setInterval(() => setLastScanTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void lastScanTick; // referenced to subscribe

  const stats = useMemo(() => {
    const crit = findings.filter((f) => f.level === "CRIT").length;
    const warn = findings.filter((f) => f.level === "WARN").length;
    const info = findings.filter((f) => f.level === "INFO").length;
    const total = findings.length;
    const health = Math.max(0, 100 - crit * 4 - warn);
    return { crit, warn, info, total, health };
  }, [findings]);

  const todayProject = useMemo(() => {
    const today = projects.find((p) => p.days_ago <= 1);
    return today ? projectName(today.path) : null;
  }, [projects]);
  const todayProjectPath = useMemo(() => {
    const today = projects.find((p) => p.days_ago <= 1);
    return today ? today.path : null;
  }, [projects]);

  const handleOpenProject = (path: string) => {
    if (!IS_TAURI) return;
    invoke("open_in_vscode", { path }).catch((e) =>
      console.error(friendlyErrorEn(e))
    );
  };
  const handleOpenUrl = (url: string) => {
    if (!IS_TAURI) {
      window.open(url, "_blank");
      return;
    }
    invoke("open_url", { url }).catch((e) => console.error(friendlyErrorEn(e)));
  };
  const handleRunAudit = () => setRefreshNonce((n) => n + 1);

  const handleCycleTheme = () => {
    applyAndPersistV3Theme(nextV3Theme(readV3ThemeFromBody()));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl+1..7 — switch tab in sidebar order
      if (e.key >= "1" && e.key <= "5") {
        const idx = Number(e.key) - 1;
        const next = KEYBOARD_TAB_ORDER[idx];
        if (next) {
          e.preventDefault();
          setTab(next);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "r") {
        e.preventDefault();
        setRefreshNonce((n) => n + 1);
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (k === "t") {
        e.preventDefault();
        handleCycleTheme();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // handleCycleTheme is stable in practice (reads from DOM each call); skip dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="appv3">
      <Topbar activeTab={tab} onTab={setTab} />
      <div className="appv3-body">
        <Sidebar
          activeTab={tab}
          onTab={setTab}
          lastScanAgo={agoLabel(lastScanAt, t)}
          onRunAudit={handleRunAudit}
          critCount={stats.crit}
          warnCount={stats.warn}
          findingTotal={stats.total}
        />
        <main className="appv3-content">
          {updates.app?.available && (
            <div className="v3-update-banner" role="status" aria-live="polite">
              <div className="v3-update-banner-body">
                <strong>{t("banner.app_available", { latest: updates.app.latest })}</strong>{" "}
                <span className="v3-update-banner-meta">
                  {t("banner.app_meta", { current: updates.app.current })}
                </span>
              </div>
              <div className="v3-update-banner-actions">
                <button
                  type="button"
                  className="v3-update-banner-primary"
                  onClick={() => handleOpenUrl(updates.app!.release_url)}
                >
                  {t("banner.open_release")}
                </button>
                <button
                  type="button"
                  className="v3-update-banner-ghost"
                  onClick={() => updates.dismissApp(updates.app!.latest)}
                >
                  {t("common.later")}
                </button>
              </div>
            </div>
          )}
          {updates.gentleAi?.available && (
            <div className="v3-update-banner" role="status" aria-live="polite">
              <div className="v3-update-banner-body">
                <strong>{t("banner.gentle_available", { latest: updates.gentleAi.latest })}</strong>{" "}
                <span className="v3-update-banner-meta">
                  {t("banner.gentle_meta", { current: updates.gentleAi.current })}
                </span>
                {gentleAiResult && (
                  <span className="v3-update-banner-result"> · {gentleAiResult}</span>
                )}
              </div>
              <div className="v3-update-banner-actions">
                <button
                  type="button"
                  className="v3-update-banner-primary"
                  onClick={handleApplyGentleAi}
                  disabled={gentleAiApplying}
                >
                  {gentleAiApplying ? t("common.updating") : t("common.update_now")}
                </button>
                <button
                  type="button"
                  className="v3-update-banner-ghost"
                  onClick={() => updates.dismissGentleAi(updates.gentleAi!.latest)}
                  disabled={gentleAiApplying}
                >
                  {t("common.later")}
                </button>
              </div>
            </div>
          )}
          {fetchErrors.length > 0 && (
            <div className="v3-fetch-banner" role="alert" aria-live="polite">
              <div className="v3-fetch-banner-body">
                <strong>{t("banner.fetch_failed")}</strong>{" "}
                <span>
                  {fetchErrors.map((e, i) => (
                    <span key={e.source}>
                      {i > 0 ? " · " : ""}
                      <span className="v3-fetch-banner-source">{e.source}</span>: {e.msg}
                    </span>
                  ))}
                </span>
              </div>
              <button
                type="button"
                className="v3-fetch-banner-retry"
                onClick={handleRunAudit}
              >
                {t("banner.retry")}
              </button>
            </div>
          )}
          {tab === "overview" && (
            <OverviewView
              greeting={`${pickGreeting(t)}.`}
              projects={projects}
              prs={prs}
              goals={goals}
              stats={stats}
              loading={loading}
              onOpenProject={handleOpenProject}
              onOpenUrl={handleOpenUrl}
              onJump={setTab}
              onCycleTheme={handleCycleTheme}
            />
          )}
          {tab === "projects" && <ProjectsView />}
          {tab === "prs" && <PrsView />}
          {tab === "audit" && <AuditView />}
          {tab === "cleanup" && <CleanupView />}
          {tab === "sync" && <SyncView />}
          {tab === "claude" && <ClaudeView />}
          {tab === "companions" && (
            <CompanionsView
              name={companionName}
              image={companionImage}
              onNameChange={setCompanionName}
              onImageChange={setCompanionImage}
            />
          )}
          {tab === "settings" && <SettingsView />}
        </main>
        <aside className="appv3-rightpanel" aria-label={t("window.companion_panel")}>
          <CompanionWidget
            companionName={companionName}
            companionImage={companionImage}
            critCount={stats.crit}
            warnCount={stats.warn}
            prCount={prs.length}
            todayProject={todayProject}
            todayProjectPath={todayProjectPath}
            lastScanAgo={agoLabel(lastScanAt, t)}
            onJump={setTab}
            onOpenProject={handleOpenProject}
          />
          <WorkspaceCard />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}

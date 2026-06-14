import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import type { AuditFinding, Project, ProjectEnrichment } from "../types";
import { agoLabel, pickGreeting, projectName, friendlyErrorEn } from "../lib/format";
import { IS_TAURI } from "../lib/env";
import type { V3Tab } from "./v3types";
import { CommandPalette } from "../components/v3/CommandPalette";
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
import { AuditView } from "../views/v3/AuditView";
import { CleanupView } from "../views/v3/CleanupView";
import { ConversationsView } from "../views/v3/ConversationsView";
import { TrelloView } from "../views/v3/TrelloView";
import { ClaudeView } from "../views/v3/ClaudeView";
import { SettingsView } from "../views/v3/SettingsView";
import "./AppV3.css";

// ===== Root =====
export default function AppV3() {
  const [tab, setTab] = useState<V3Tab>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  // Full enrichment (goal + git_last_commit) shared with ProjectsView so
  // it doesn't run a parallel enrichProjects call. OverviewView still
  // reads the lighter `goals` map (it doesn't need git info).
  const [enrichment, setEnrichment] = useState<
    Record<string, ProjectEnrichment>
  >({});
  const [loading, setLoading] = useState(true);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [lastScanTick, setLastScanTick] = useState(0); // forces re-render of "X ago"
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Window days for scan_projects, lifted from ProjectsView so AppV3 +
  // Projects share one fetch instead of duplicating it. Persisted to
  // localStorage so the user's choice survives reloads.
  const [windowDays, setWindowDays] = useState<number>(() => {
    const saved = parseInt(
      typeof window !== "undefined"
        ? (window.localStorage.getItem("csk-window-days") ?? "")
        : "",
      10,
    );
    return Number.isFinite(saved) && saved > 0 ? saved : 14;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("csk-window-days", String(windowDays));
    } catch {
      /* storage full / locked — ignore */
    }
  }, [windowDays]);
  // Command palette (Cmd+K) open state.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Per-source fetch errors — surfaced via the retry banner so backend
  // failures stop masquerading as empty states.
  const [fetchErrors, setFetchErrors] = useState<{ source: string; msg: string }[]>([]);

  // i18n hook — every helper that produces user-facing strings (greeting,
  // ago labels, headlines) takes `t` as a parameter so they stay pure.
  const { t } = useT();

  // First-run autostart bootstrap. The user explicitly asked for the app
  // to launch with Windows; we honor that on the very first launch IF the
  // user hasn't been prompted yet (tracked in localStorage). After this
  // they're free to toggle it off in Settings — we never re-enable on
  // subsequent runs, only the very first one.
  useEffect(() => {
    if (!IS_TAURI) return;
    const FLAG = "csk-autostart-first-run-done";
    if (localStorage.getItem(FLAG) === "1") return;
    isAutostartEnabled()
      .then((already) => {
        if (already) {
          localStorage.setItem(FLAG, "1");
          return;
        }
        return enableAutostart()
          .then(() => localStorage.setItem(FLAG, "1"))
          .catch(() => {
            // Silent failure on first-run nudge — the user can still flip
            // the toggle in Settings manually.
            localStorage.setItem(FLAG, "1");
          });
      })
      .catch(() => {
        // Probably a non-Tauri preview; mark as done so we don't loop.
        localStorage.setItem(FLAG, "1");
      });
  }, []);

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
        const [projectsP, knownP, findingsP] = [
          invoke<Project[]>("scan_projects", { windowDays }).catch(
            trap<Project[]>("Projects", [])
          ),
          invoke<string[]>("engram_known_projects").catch(
            trap<string[]>("Engram", [])
          ),
          invoke<unknown>("run_audit")
            .then(parseAuditFindings)
            .catch(trap<AuditFinding[]>("Audit", [])),
        ];
        const [projectsRes, known, findingsRes] = await Promise.all([
          projectsP,
          knownP,
          findingsP,
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
        setFindings(findingsRes);
        setGoals(goalMap);
        setEnrichment(enrichment);
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
  }, [refreshNonce, windowDays]);

  // Tick for "X ago" updates every 30s.
  useEffect(() => {
    const id = setInterval(() => setLastScanTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void lastScanTick; // referenced to subscribe

  const stats = useMemo(() => {
    // Exclude findings the user explicitly muted via the "Ignorar" button.
    // Sidebar dot, companion headline, overview tree, statusbar — they all
    // read from here, and showing a yellow dot for a warn the user already
    // marked benign is exactly what they complained about.
    const active = findings.filter((f) => !f.ignored);
    const crit = active.filter((f) => f.level === "CRIT").length;
    const warn = active.filter((f) => f.level === "WARN").length;
    const info = active.filter((f) => f.level === "INFO").length;
    const total = active.length;
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
  const handleRunAudit = () => setRefreshNonce((n) => n + 1);

  const handleCycleTheme = () => {
    applyAndPersistV3Theme(nextV3Theme(readV3ThemeFromBody()));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl+1..9 — switch tab in sidebar order (overview, projects,
      // conversations, trello, audit, cleanup). Driven by KEYBOARD_TAB_ORDER.
      if (e.key >= "1" && e.key <= "9") {
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
      if (k === "k") {
        // Cmd/Ctrl+K opens the command palette. Universal — works
        // regardless of theme. Toggles closed if already open.
        e.preventDefault();
        setPaletteOpen((p) => !p);
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
          projects={projects}
          onOpenProject={handleOpenProject}
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
                  onClick={() => {
                    void updates.applyApp();
                  }}
                  disabled={updates.applyingApp}
                >
                  {updates.applyingApp
                    ? t("common.updating")
                    : t("common.update_now")}
                </button>
                <button
                  type="button"
                  className="v3-update-banner-ghost"
                  onClick={() => updates.dismissApp(updates.app!.latest)}
                  disabled={updates.applyingApp}
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
              goals={goals}
              stats={stats}
              loading={loading}
              onOpenProject={handleOpenProject}
              onJump={setTab}
              onCycleTheme={handleCycleTheme}
              onOpenPalette={() => setPaletteOpen(true)}
            />
          )}
          {tab === "projects" && (
            <ProjectsView
              projects={projects}
              enrichment={enrichment}
              loading={loading}
              windowDays={windowDays}
              setWindowDays={setWindowDays}
            />
          )}
          {tab === "audit" && (
            <AuditView
              onJump={setTab}
              findings={findings}
              loading={loading}
              onRefresh={handleRunAudit}
            />
          )}
          {tab === "cleanup" && <CleanupView />}
          {tab === "conversations" && <ConversationsView />}
          {tab === "trello" && <TrelloView />}
          {tab === "claude" && <ClaudeView />}
          {tab === "settings" && (
            <SettingsView
              companionName={companionName}
              companionImage={companionImage}
              onCompanionNameChange={setCompanionName}
              onCompanionImageChange={setCompanionImage}
            />
          )}
        </main>
        <aside className="appv3-rightpanel" aria-label={t("window.companion_panel")}>
          <CompanionWidget
            companionName={companionName}
            companionImage={companionImage}
            critCount={stats.crit}
            warnCount={stats.warn}
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onTab={setTab}
        onRunAudit={handleRunAudit}
        onCycleTheme={handleCycleTheme}
      />
    </div>
  );
}

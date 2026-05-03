// Tiny i18n layer. Two languages: en (default) + es (Rioplatense).
//
// Strings live in a single typed catalog so missing keys are caught at
// compile time. The active locale is stored in localStorage and broadcast
// via a custom event so any component using useT() re-renders on switch
// without lifting state to AppV3.
//
// We deliberately keep this minimal — no plurals, no interpolation library,
// no message-format. Where a string needs a value, the function form
// `t("key", { count: 3 })` substitutes `{count}` placeholders.

import { useEffect, useState } from "react";

export type Lang = "en" | "es";
export type LangPref = Lang | "auto";

export const LANGS: Lang[] = ["en", "es"];

const STRINGS = {
  // Sidebar nav
  "nav.overview": { en: "Overview", es: "Resumen" },
  "nav.projects": { en: "Projects", es: "Proyectos" },
  "nav.prs": { en: "Pull Requests", es: "Pull Requests" },
  "nav.audit": { en: "Audit", es: "Auditoría" },
  "nav.cleanup": { en: "Cleanup", es: "Limpieza" },
  "nav.claude": { en: "Claude", es: "Claude" },
  "nav.companions": { en: "Companions", es: "Compañeros" },
  "nav.settings": { en: "Settings", es: "Ajustes" },
  "nav.sync": { en: "Sync", es: "Sync" },

  // System status (sidebar bottom card)
  "status.operational": { en: "All systems operational", es: "Todo funcionando" },
  "status.idle": { en: "Awaiting first audit", es: "Esperando primera auditoría" },
  "status.crit_one": { en: "{n} critical issue", es: "{n} problema crítico" },
  "status.crit_other": { en: "{n} critical issues", es: "{n} problemas críticos" },
  "status.warn_one": { en: "{n} warning", es: "{n} advertencia" },
  "status.warn_other": { en: "{n} warnings", es: "{n} advertencias" },
  "status.last_scan": { en: "Last scan", es: "Último scan" },
  "status.run_audit": { en: "Run audit", es: "Auditar" },
  "status.crit_short": { en: "crit", es: "crít" },
  "status.warn_short": { en: "warn", es: "adv" },

  // Statusbar (bottom)
  "statusbar.ready": { en: "Ready", es: "Listo" },
  "statusbar.projects_one": { en: "{n} project", es: "{n} proyecto" },
  "statusbar.projects_other": { en: "{n} projects", es: "{n} proyectos" },
  "statusbar.findings_one": { en: "{n} finding", es: "{n} hallazgo" },
  "statusbar.findings_other": { en: "{n} findings", es: "{n} hallazgos" },
  "statusbar.scan": { en: "Scan {ago}", es: "Scan {ago}" },

  // Greeting + small bits
  "greeting.morning": { en: "Good morning", es: "Buen día" },
  "greeting.afternoon": { en: "Good afternoon", es: "Buenas tardes" },
  "greeting.evening": { en: "Good evening", es: "Buenas noches" },
  "common.refresh": { en: "Refresh", es: "Refrescar" },
  "common.refreshing": { en: "Refreshing…", es: "Refrescando…" },
  "common.loading": { en: "Loading…", es: "Cargando…" },
  "common.later": { en: "Later", es: "Más tarde" },
  "common.update_now": { en: "Update now", es: "Actualizar" },
  "common.updating": { en: "Updating…", es: "Actualizando…" },
  "common.open": { en: "Open", es: "Abrir" },
  "common.never": { en: "never", es: "nunca" },
  "common.just_now": { en: "just now", es: "recién" },
  "ago.seconds": { en: "{n}s ago", es: "hace {n}s" },
  "ago.minutes": { en: "{n}m ago", es: "hace {n}m" },
  "ago.hours": { en: "{n}h ago", es: "hace {n}h" },
  "ago.days": { en: "{n}d ago", es: "hace {n}d" },

  // Companion widget — single-line nudge, never the same data the System
  // Status card already shows.
  "companion.online": { en: "Online", es: "En línea" },
  "companion.idle": {
    en: "I've reviewed your workspace. Nothing critical to flag right now.",
    es: "Revisé tu workspace. Nada crítico para marcar ahora.",
  },
  "companion.has_crits": {
    en: "I've analyzed your workspace. There are {n} critical issues that should be addressed.",
    es: "Analicé tu workspace. Hay {n} problemas críticos que deberías revisar.",
  },
  "companion.has_warns": {
    en: "Audit clean on critical. {n} warnings you can address when you have time.",
    es: "Sin críticos. {n} advertencias para mirar cuando tengas un rato.",
  },
  "companion.has_prs": {
    en: "Workspace healthy. {n} pull requests waiting for your review.",
    es: "Workspace sano. Hay {n} pull requests esperando tu review.",
  },
  "companion.today": {
    en: "You've been working on {project} today. Audit's clean.",
    es: "Estuviste trabajando en {project} hoy. Sin hallazgos críticos.",
  },
  // Last-scan label inside the companion footer
  "companion.stat_scan": { en: "Last scan", es: "Último scan" },
  // Workspace sync (Settings card — engram-only over a private GitHub repo)
  "sync.title": { en: "Workspace sync", es: "Sync del workspace" },
  "sync.lead": {
    en: "Mirror your engram memory to a private GitHub repo so you can pick up the same context on another machine.",
    es: "Espejá tu memoria de engram a un repo privado de GitHub para retomar el contexto en otra máquina.",
  },
  "sync.repo_label": { en: "Repository name", es: "Nombre del repo" },
  "sync.repo_placeholder": { en: "claude-sync", es: "claude-sync" },
  "sync.repo_hint": {
    en: "Will be created under your gh user as private. You can also paste a full owner/name.",
    es: "Se crea privado bajo tu usuario de gh. También aceptá owner/name completo.",
  },
  "sync.setup": { en: "Set up sync", es: "Configurar sync" },
  "sync.setting_up": { en: "Setting up…", es: "Configurando…" },
  "sync.connected_to": { en: "Connected to", es: "Conectado a" },
  "sync.last_sync": { en: "Last sync", es: "Último sync" },
  "sync.last_sync_export": { en: "exported", es: "exportado" },
  "sync.last_sync_import": { en: "imported", es: "importado" },
  "sync.never_synced": { en: "Never synced yet", es: "Nunca sincronizado" },
  "sync.export_now": { en: "Push to remote", es: "Subir al remoto" },
  "sync.exporting": { en: "Pushing…", es: "Subiendo…" },
  "sync.import_now": { en: "Pull from remote", es: "Bajar del remoto" },
  "sync.importing": { en: "Pulling…", es: "Bajando…" },
  "sync.disconnect": { en: "Disconnect", es: "Desconectar" },
  "sync.confirm_import": {
    en: "This will overwrite engram memory on this machine with the remote. Continue?",
    es: "Esto va a pisar la memoria de engram en esta máquina con la del remoto. ¿Seguir?",
  },
  "sync.confirm_disconnect": {
    en: "Stop syncing? The remote repo stays on GitHub — you can re-attach later.",
    es: "¿Detener el sync? El repo remoto queda en GitHub, podés re-conectar después.",
  },
  // Project clone section (shown when projects.json has entries)
  "sync.projects_title": { en: "Projects on this remote", es: "Proyectos en este remoto" },
  "sync.projects_empty": {
    en: "No projects with git remotes were detected on the source machine.",
    es: "No se detectaron proyectos con remoto en la máquina fuente.",
  },
  "sync.projects_lead": {
    en: "Clone any of these into a folder on this machine. Already-existing folders are skipped.",
    es: "Cloná cualquiera de estos en una carpeta de esta máquina. Las que ya existen se omiten.",
  },
  "sync.target_label": { en: "Clone into", es: "Clonar en" },
  "sync.target_placeholder": { en: "C:\\code", es: "C:\\code" },
  "sync.clone_all": { en: "Clone all", es: "Clonar todos" },
  "sync.cloning": { en: "Cloning…", es: "Clonando…" },
  "sync.clone_one": { en: "Clone", es: "Clonar" },
  "sync.clone_status_cloned": { en: "Cloned", es: "Clonado" },
  "sync.clone_status_exists": { en: "Already exists", es: "Ya existe" },
  "sync.clone_status_error": { en: "Failed", es: "Falló" },

  // Workspace card (sits under the companion in the right panel)
  "workspace.title": { en: "Workspace", es: "Workspace" },
  "workspace.skills": { en: "Skills used", es: "Skills usadas" },
  "workspace.engram": { en: "Engram memory", es: "Memoria Engram" },
  "workspace.engram_obs": { en: "{n} obs", es: "{n} obs" },
  "workspace.app": { en: "App", es: "App" },
  "workspace.gentle_ai": { en: "gentle-ai", es: "gentle-ai" },
  // Contextual action buttons (one is shown, picked by current state)
  "companion.action_review_audit": { en: "Review audit", es: "Ver auditoría" },
  "companion.action_open_prs": { en: "Open PRs", es: "Ver PRs" },
  "companion.action_open_project": { en: "Open today's project", es: "Abrir proyecto del día" },
  "companion.action_browse_projects": { en: "Browse projects", es: "Ver proyectos" },

  // Settings
  "settings.title": { en: "Settings", es: "Ajustes" },
  "settings.subtitle": {
    en: "App preferences and configuration.",
    es: "Preferencias y configuración de la app.",
  },
  "settings.language": { en: "Language", es: "Idioma" },
  "settings.language_auto": { en: "System", es: "Sistema" },
  "settings.language_en": { en: "English", es: "Inglés" },
  "settings.language_es": { en: "Spanish (Rioplatense)", es: "Español (Rioplatense)" },
} as const;

export type StringKey = keyof typeof STRINGS;

// ── Locale storage + event bus ─────────────────────────────────────────
const LS_KEY = "csk-lang";
const EVENT = "csk-lang-change";

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "en" || v === "es" || v === "auto") return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

function detectSystem(): Lang {
  if (typeof navigator === "undefined") return "en";
  const tag = navigator.language || "en";
  return tag.toLowerCase().startsWith("es") ? "es" : "en";
}

export function getLang(pref: LangPref = readPref()): Lang {
  return pref === "auto" ? detectSystem() : pref;
}

export function setLangPref(pref: LangPref): void {
  try {
    localStorage.setItem(LS_KEY, pref);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<LangPref>(EVENT, { detail: pref }));
}

export function getLangPref(): LangPref {
  return readPref();
}

// ── Hook ───────────────────────────────────────────────────────────────
export function useT(): {
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  lang: Lang;
  pref: LangPref;
  setPref: (p: LangPref) => void;
} {
  const [pref, setPref] = useState<LangPref>(() => readPref());
  useEffect(() => {
    const onChange = () => setPref(readPref());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  const lang = getLang(pref);
  const t = (key: StringKey, vars?: Record<string, string | number>): string => {
    const entry = STRINGS[key];
    if (!entry) return String(key);
    // Widen the inferred literal union to plain string so .replace() can
    // narrow back without confusing the checker.
    let s: string = entry[lang] ?? entry.en;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{${k}}`, String(v));
      }
    }
    return s;
  };
  return {
    t,
    lang,
    pref,
    setPref: (p) => {
      setLangPref(p);
      setPref(p);
    },
  };
}

// Picks the right plural variant for a "one|other" pair. Trivial because we
// only support en + es (both have the same one/other split).
export function plural(
  t: (key: StringKey, vars?: Record<string, string | number>) => string,
  count: number,
  oneKey: StringKey,
  otherKey: StringKey
): string {
  return count === 1 ? t(oneKey, { n: count }) : t(otherKey, { n: count });
}

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
  "companion.idle": { en: "Ready when you need me.", es: "Listo cuando lo necesites." },
  "companion.has_crits": { en: "Critical issues to review.", es: "Hay cosas críticas para revisar." },
  "companion.has_warns": { en: "Some warnings to look at.", es: "Hay advertencias para mirar." },
  "companion.has_prs": { en: "PRs awaiting your review.", es: "PRs esperando tu review." },
  "companion.today": { en: "Working on {project} today.", es: "Estás en {project} hoy." },
  // Stats strip below the avatar
  "companion.stat_health": { en: "Health", es: "Salud" },
  "companion.stat_week": { en: "This week", es: "Esta semana" },
  "companion.stat_today": { en: "Today", es: "Hoy" },
  "companion.stat_scan": { en: "Last scan", es: "Último scan" },
  "companion.stat_today_none": { en: "—", es: "—" },
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

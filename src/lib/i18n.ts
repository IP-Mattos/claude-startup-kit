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
  "common.continue": { en: "Continue", es: "Seguir" },
  "common.cancel": { en: "Cancel", es: "Cancelar" },
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
    en: "I've analyzed your workspace.\n{n} critical issues should be addressed.",
    es: "Analicé tu workspace.\nHay {n} problemas críticos para revisar.",
  },
  "companion.has_warns": {
    en: "Audit clean on critical.\n{n} warnings to look at when you have time.",
    es: "Sin críticos.\n{n} advertencias para mirar cuando tengas un rato.",
  },
  "companion.has_prs": {
    en: "Workspace healthy.\n{n} pull requests waiting for your review.",
    es: "Workspace sano.\nHay {n} pull requests esperando tu review.",
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
  "sync.confirm_import_title": {
    en: "Pull from remote",
    es: "Bajar del remoto",
  },
  "sync.confirm_import": {
    en: "This will overwrite engram memory on this machine with the remote. Continue?",
    es: "Esto va a pisar la memoria de engram en esta máquina con la del remoto. ¿Seguir?",
  },
  "sync.confirm_disconnect_title": {
    en: "Disconnect sync",
    es: "Desconectar sync",
  },
  "sync.confirm_disconnect": {
    en: "Stop syncing? The remote repo stays on GitHub — you can re-attach later.",
    es: "¿Detener el sync? El repo remoto queda en GitHub, podés re-conectar después.",
  },
  "sync.target_pick": { en: "Choose folder…", es: "Elegir carpeta…" },
  "sync.target_picker_title": {
    en: "Pick a folder to clone projects into",
    es: "Elegí una carpeta para clonar los proyectos",
  },
  "sync.alias_label": { en: "alias", es: "alias" },
  "sync.clone_status_cloning": { en: "Cloning…", es: "Clonando…" },
  "sync.repo_preview": {
    en: "Will create a private repo at github.com/{full}",
    es: "Se va a crear un repo privado en github.com/{full}",
  },
  "sync.repo_preview_no_user": {
    en: "Will create a private repo named {name} (gh login pending)",
    es: "Se va a crear un repo privado llamado {name} (falta login en gh)",
  },
  "sync.gh_repos_title": {
    en: "All your GitHub repos",
    es: "Todos tus repos de GitHub",
  },
  "sync.gh_repos_lead": {
    en: "Browse every repo gh sees and clone any of them — independent of sync metadata.",
    es: "Navegá todos los repos que ve gh y cloná cualquiera — independiente del metadata de sync.",
  },
  "sync.gh_repos_search_placeholder": {
    en: "Filter repos…",
    es: "Filtrar repos…",
  },
  "sync.gh_repos_empty": {
    en: "No repos visible to gh. Check `gh auth status`.",
    es: "Ningún repo visible para gh. Revisá `gh auth status`.",
  },
  "sync.gh_repos_empty_search": {
    en: "No repos match the filter.",
    es: "Ningún repo coincide con el filtro.",
  },
  "sync.gh_repo_private": { en: "private", es: "privado" },
  "cleanup.confirm_title": {
    en: "Delete files?",
    es: "¿Borrar archivos?",
  },
  "cleanup.confirm_message": {
    en: "About to delete {n} item(s) · {bytes} of disk. This cannot be undone.",
    es: "Vas a borrar {n} elemento(s) · {bytes} de disco. No se puede deshacer.",
  },
  "onboarding.aria": { en: "Welcome card", es: "Tarjeta de bienvenida" },
  "onboarding.title": {
    en: "Welcome to Claude Startup Kit",
    es: "Bienvenido a Claude Startup Kit",
  },
  "onboarding.message": {
    en: "We turned on launch-on-startup so the app is ready every time you log in. Sync your engram memory to GitHub to share it across machines, or tweak the rest in Settings.",
    es: "Activamos el inicio automático con Windows para que la app esté lista cada vez que prendas la PC. Sincronizá tu memoria de engram con GitHub para compartirla entre máquinas, o ajustá el resto en Configuración.",
  },
  "onboarding.cta_sync": { en: "Set up sync", es: "Configurar sync" },
  "onboarding.cta_settings": { en: "Open Settings", es: "Abrir Configuración" },
  "onboarding.dismiss": { en: "Dismiss", es: "Cerrar" },
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
  "settings.language_es": { en: "Spanish", es: "Español" },
  "settings.updates": { en: "Updates", es: "Actualizaciones" },
  "settings.check_now": { en: "Check now", es: "Buscar ahora" },
  "settings.checking": { en: "Checking…", es: "Buscando…" },
  "settings.updates_auto_hint": {
    en: 'Updates are checked automatically once every 24 hours. Click "Check now" to refresh immediately.',
    es: "Las actualizaciones se buscan automáticamente cada 24 horas. Tocá \"Buscar ahora\" para refrescar al toque.",
  },
  "settings.autostart_title": { en: "Startup", es: "Inicio" },
  "settings.autostart_label": {
    en: "Launch Claude Startup Kit when Windows starts",
    es: "Abrir Claude Startup Kit cuando inicie Windows",
  },
  "settings.autostart_hint": {
    en: "Opens the app on every login, minimized to the tray. Toggle off any time.",
    es: "Abre la app en cada inicio de sesión, minimizada en la bandeja. Lo desactivás cuando quieras.",
  },
  "settings.theme": { en: "Theme", es: "Tema" },
  "settings.curated_palettes": { en: "{n} curated palettes", es: "{n} paletas curadas" },
  "settings.shortcuts": { en: "Keyboard Shortcuts", es: "Atajos de teclado" },
  "settings.shortcut_switch_tabs": {
    en: "Switch tabs (Overview → Settings)",
    es: "Cambiar pestañas (Resumen → Ajustes)",
  },
  "settings.shortcut_refresh": {
    en: "Refresh current tab data",
    es: "Refrescar la pestaña actual",
  },
  "settings.shortcut_open_settings": { en: "Open Settings", es: "Abrir Ajustes" },
  "settings.shortcut_cycle_theme": { en: "Cycle theme", es: "Cambiar tema" },
  "settings.update_not_configured": { en: "Not configured", es: "No configurado" },
  "settings.update_up_to_date": { en: "up to date", es: "al día" },
  "settings.update_app_hint": {
    en: "No release published yet on GitHub. Configure once a release pipeline ships.",
    es: "Todavía no hay release publicado en GitHub. Configurá cuando haya pipeline de releases.",
  },
  "settings.update_gentle_ai_hint": {
    en: "gentle-ai is not on PATH. Install it from gentle-ai's repo.",
    es: "gentle-ai no está en el PATH. Instalalo desde el repo de gentle-ai.",
  },
  "settings.update_app_label": { en: "Claude Startup Kit", es: "Claude Startup Kit" },
  "settings.update_gentle_ai_label": { en: "gentle-ai", es: "gentle-ai" },

  // Stack tools card — managed by gentle-ai, surfaced via check_stack_updates
  "settings.stack_title": { en: "Stack tools", es: "Herramientas del stack" },
  "settings.stack_hint": {
    en: "Managed by gentle-ai. New tools appear here automatically as the upstream catalog grows.",
    es: "Lo gestiona gentle-ai. Las herramientas nuevas aparecen acá solas cuando crece el catálogo upstream.",
  },
  "settings.stack_empty": {
    en: "No managed tools detected. Install gentle-ai to populate the list.",
    es: "No se detectaron herramientas gestionadas. Instalá gentle-ai para poblar la lista.",
  },
  "settings.stack_apply_all": { en: "Update all", es: "Actualizar todo" },
  "settings.stack_applying": { en: "Updating…", es: "Actualizando…" },
  "settings.stack_apply_all_title": {
    en: "Run gentle-ai upgrade across every managed tool",
    es: "Corre gentle-ai upgrade sobre todas las herramientas gestionadas",
  },
  "settings.stack_confirm_title": {
    en: "Update the whole stack?",
    es: "¿Actualizar todo el stack?",
  },
  "settings.stack_confirm_message": {
    en: "Will close any running engram / gga processes (Claude Code re-spawns them) and run gentle-ai upgrade. Safe to run when everything is up to date.",
    es: "Se van a cerrar los procesos engram / gga abiertos (Claude Code los relanza solo) y se va a correr gentle-ai upgrade. Seguro aunque ya esté todo al día.",
  },
  "settings.stack_state_not_installed": {
    en: "Not installed (latest: v{latest})",
    es: "No instalada (última: v{latest})",
  },
  "settings.stack_install": { en: "Install", es: "Instalar" },
  "settings.stack_install_title": {
    en: "Open gentle-ai's interactive install wizard",
    es: "Abre el wizard interactivo de instalación de gentle-ai",
  },

  // Banners (top of content area)
  "banner.app_available": {
    en: "Claude Startup Kit v{latest}",
    es: "Claude Startup Kit v{latest}",
  },
  "banner.app_meta": {
    en: "is available (you're on v{current})",
    es: "está disponible (vos estás en v{current})",
  },
  "banner.gentle_available": {
    en: "gentle-ai v{latest}",
    es: "gentle-ai v{latest}",
  },
  "banner.gentle_meta": {
    en: "is available (you're on v{current})",
    es: "está disponible (vos estás en v{current})",
  },
  "banner.open_release": { en: "Open release", es: "Abrir release" },
  "banner.fetch_failed": { en: "Some data failed to load.", es: "Algunos datos no cargaron." },
  "banner.retry": { en: "Retry", es: "Reintentar" },
  "banner.gentle_upgraded": {
    en: "gentle-ai upgraded to v{v}",
    es: "gentle-ai actualizado a v{v}",
  },
  "banner.update_failed": { en: "Update failed", es: "Falló la actualización" },

  // Window controls
  "window.minimize": { en: "Minimize", es: "Minimizar" },
  "window.maximize": { en: "Maximize", es: "Maximizar" },
  "window.restore": { en: "Restore", es: "Restaurar" },
  "window.close": { en: "Close", es: "Cerrar" },
  "window.companion_panel": { en: "Companion panel", es: "Panel del compañero" },
  "window.primary_nav": { en: "Primary navigation", es: "Navegación principal" },
  "common.cycle_theme": { en: "Cycle theme", es: "Cambiar tema" },
  "common.cycle_theme_title": { en: "Cycle theme (Ctrl+T)", es: "Cambiar tema (Ctrl+T)" },
  "common.open_settings": { en: "Open settings", es: "Abrir ajustes" },
  "common.settings_title": { en: "Settings (Ctrl+,)", es: "Ajustes (Ctrl+,)" },

  // Overview
  "overview.subtitle": {
    en: "Here's what's happening across your workspace.",
    es: "Esto es lo que está pasando en tu workspace.",
  },
  "overview.stat_projects": { en: "Projects", es: "Proyectos" },
  "overview.stat_prs": { en: "Pull Requests", es: "Pull Requests" },
  "overview.stat_findings": { en: "Audit Findings", es: "Hallazgos" },
  "overview.stat_health": { en: "Health Score", es: "Salud" },
  "overview.this_week": { en: "{n} this week", es: "{n} esta semana" },
  "overview.open_count": { en: "{n} open", es: "{n} abiertas" },
  "overview.high_priority": { en: "{n} high priority", es: "{n} alta prioridad" },
  "overview.zero_critical": { en: "0 critical", es: "0 críticos" },
  "overview.n_critical": { en: "{n} critical", es: "{n} críticos" },
  "overview.recent_projects": { en: "Recent Projects", es: "Proyectos recientes" },
  "overview.recent_prs": { en: "Recent Pull Requests", es: "Pull Requests recientes" },
  "overview.audit_summary": { en: "Audit Summary", es: "Resumen de auditoría" },
  "overview.view_all": { en: "View all", es: "Ver todos" },
  "overview.loading_projects": { en: "Loading projects…", es: "Cargando proyectos…" },
  "overview.loading_prs": { en: "Loading PRs…", es: "Cargando PRs…" },
  "overview.no_recent_projects": { en: "No recent projects detected.", es: "No se detectaron proyectos recientes." },
  "overview.no_prs": { en: "No PRs awaiting your review.", es: "No hay PRs esperando tu review." },
  "overview.audit_clean": { en: "Audit clean. No findings.", es: "Auditoría limpia. Sin hallazgos." },
  "overview.tile_critical": { en: "Critical", es: "Críticos" },
  "overview.tile_warning": { en: "Warning", es: "Advertencias" },
  "overview.tile_info": { en: "Info", es: "Info" },
  "overview.total_findings": { en: "total findings", es: "hallazgos totales" },
  "overview.crit_attention_one": {
    en: "{n} critical issue needs your attention",
    es: "{n} problema crítico necesita tu atención",
  },
  "overview.crit_attention_other": {
    en: "{n} critical issues need your attention",
    es: "{n} problemas críticos necesitan tu atención",
  },
  "overview.audit_bar_label": {
    en: "{total} audit findings: {crit} critical, {warn} warnings, {info} info",
    es: "{total} hallazgos: {crit} críticos, {warn} advertencias, {info} info",
  },
  "overview.open_pr_label": { en: "Open pull request {title}", es: "Abrir pull request {title}" },
  "overview.open_project_label": { en: "Open project {name}", es: "Abrir proyecto {name}" },

  // Activity labels (today/yesterday/Nd ago)
  "activity.today": { en: "today", es: "hoy" },
  "activity.yesterday": { en: "yesterday", es: "ayer" },
  "activity.days_ago": { en: "{n}d ago", es: "hace {n}d" },

  // Projects view
  "projects.title": { en: "Projects", es: "Proyectos" },
  "projects.scanning": { en: "Scanning…", es: "Escaneando…" },
  "projects.summary_one": {
    en: "{filtered} of {total} project in the last {days} days.",
    es: "{filtered} de {total} proyecto en los últimos {days} días.",
  },
  "projects.summary_other": {
    en: "{filtered} of {total} projects in the last {days} days.",
    es: "{filtered} de {total} proyectos en los últimos {days} días.",
  },
  "projects.search_placeholder": { en: "Search projects…", es: "Buscar proyectos…" },
  "projects.search_aria": { en: "Search projects", es: "Buscar proyectos" },
  "projects.time_window": { en: "Time window", es: "Rango de tiempo" },
  "projects.window_7d": { en: "7 days", es: "7 días" },
  "projects.window_14d": { en: "14 days", es: "14 días" },
  "projects.window_30d": { en: "30 days", es: "30 días" },
  "projects.window_90d": { en: "90 days", es: "90 días" },
  "projects.loading": { en: "Loading projects…", es: "Cargando proyectos…" },
  "projects.empty_window": {
    en: "No projects detected in the last {days} days.",
    es: "No se detectaron proyectos en los últimos {days} días.",
  },
  "projects.empty_search": {
    en: 'No projects match "{q}".',
    es: 'Ningún proyecto coincide con "{q}".',
  },
  "projects.open_in_explorer": { en: "Open in Explorer", es: "Abrir en Explorer" },
  "projects.disk_scan_title": {
    en: "More repos on disk",
    es: "Más repos en disco",
  },
  "projects.disk_scan_lead": {
    en: "Walks common dev folders looking for .git/. Surfaces repos that aren't in the Claude Code activity list above.",
    es: "Recorre carpetas dev típicas buscando .git/. Aparecen repos que no están en la lista de actividad de Claude Code de arriba.",
  },
  "projects.disk_scan_run": { en: "Search now", es: "Buscar ahora" },
  "projects.disk_scan_rerun": { en: "Search again", es: "Buscar de nuevo" },
  "projects.disk_scan_running": { en: "Searching…", es: "Buscando…" },
  "projects.disk_scan_empty": {
    en: "No additional git repos found in the default scan locations.",
    es: "No se encontraron repos git adicionales en las ubicaciones por defecto.",
  },

  // PRs view
  "prs.title": { en: "Pull Requests", es: "Pull Requests" },
  "prs.summary_one": { en: "{n} PR awaiting your review.", es: "{n} PR esperando tu review." },
  "prs.summary_other": { en: "{n} PRs awaiting your review.", es: "{n} PRs esperando tu review." },
  "prs.search_placeholder": {
    en: "Search PRs by title, repo, or author…",
    es: "Buscar PRs por título, repo o autor…",
  },
  "prs.search_aria": { en: "Search pull requests", es: "Buscar pull requests" },
  "prs.loading": { en: "Loading pull requests…", es: "Cargando pull requests…" },
  "prs.inbox_zero": {
    en: "No PRs awaiting your review. Inbox zero.",
    es: "No hay PRs esperando review. Inbox zero.",
  },
  "prs.empty_search": {
    en: 'No PRs match "{q}".',
    es: 'Ningún PR coincide con "{q}".',
  },
  "prs.open": { en: "Open", es: "Abrir" },
  "prs.by_author": { en: "by {author}", es: "por {author}" },
  "prs.open_label": { en: "Open pull request {title}", es: "Abrir pull request {title}" },

  // Audit view
  "audit.title": { en: "Audit", es: "Auditoría" },
  "audit.running": { en: "Running audit…", es: "Corriendo auditoría…" },
  "audit.summary_one": {
    en: "{n} finding across your workspace.",
    es: "{n} hallazgo en tu workspace.",
  },
  "audit.summary_other": {
    en: "{n} findings across your workspace.",
    es: "{n} hallazgos en tu workspace.",
  },
  "audit.rerun": { en: "Re-run", es: "Re-ejecutar" },
  "audit.filter_all": { en: "All {n}", es: "Todos {n}" },
  "audit.filter_critical": { en: "Critical {n}", es: "Críticos {n}" },
  "audit.filter_warning": { en: "Warning {n}", es: "Advertencias {n}" },
  "audit.filter_info": { en: "Info {n}", es: "Info {n}" },
  "audit.clean": { en: "Audit clean. Nothing to report.", es: "Auditoría limpia. Nada para reportar." },
  "audit.no_match": { en: "No findings match the current filter.", es: "Ningún hallazgo coincide con el filtro." },
  "audit.resolve": { en: "Fix", es: "Resolver" },
  "audit.action_done": { en: "Done.", es: "Hecho." },
  "audit.confirm_kill_title": { en: "Kill process?", es: "¿Matar proceso?" },
  "audit.confirm_kill_message": {
    en: "About to terminate PID {pid}. Unsaved data may be lost.",
    es: "Vas a terminar el PID {pid}. Podés perder datos sin guardar.",
  },
  "audit.confirm_delete_title": { en: "Delete file?", es: "¿Borrar archivo?" },
  "audit.confirm_delete_message": {
    en: "Permanently delete {path}? This cannot be undone.",
    es: "¿Borrar definitivamente {path}? No se puede deshacer.",
  },
  "audit.confirm_delete_settings_local_title": {
    en: "Delete settings.local.json?",
    es: "¿Borrar settings.local.json?",
  },
  "audit.confirm_delete_settings_local_message": {
    en: "Removes the local override so settings.json takes effect again. Local-only permissions are LOST. The file is moved to ~/.claude/backups/audit-<timestamp>/ so you can restore it manually if you change your mind.",
    es: "Elimina el override local — settings.json vuelve a tener efecto. Las permisos locales se PIERDEN. El archivo se mueve a ~/.claude/backups/audit-<timestamp>/ por si querés recuperarlo después.",
  },
  "audit.confirm_restore_title": {
    en: "Restore settings backup?",
    es: "¿Restaurar backup de settings?",
  },
  "audit.confirm_restore_message": {
    en: "settings.json will be replaced with the most recent backup. Current file is overwritten.",
    es: "settings.json se reemplaza con el último backup. El archivo actual se sobreescribe.",
  },
  // Cleanup view
  "cleanup.title": { en: "Cleanup", es: "Limpieza" },
  "cleanup.scanning": { en: "Scanning…", es: "Escaneando…" },
  "cleanup.tidy": { en: "Nothing to clean. Disk is tidy.", es: "Nada para limpiar. Disco prolijo." },
  "cleanup.summary_one": {
    en: "{n} stale item · {bytes} can be freed.",
    es: "{n} ítem viejo · {bytes} para liberar.",
  },
  "cleanup.summary_other": {
    en: "{n} stale items · {bytes} can be freed.",
    es: "{n} ítems viejos · {bytes} para liberar.",
  },
  "cleanup.cleaning": { en: "Cleaning…", es: "Limpiando…" },
  "cleanup.clean_all": { en: "Clean all", es: "Limpiar todo" },
  "cleanup.deleted_one": {
    en: "Deleted {n} item, freed {bytes}",
    es: "Borraste {n} ítem, liberaste {bytes}",
  },
  "cleanup.deleted_other": {
    en: "Deleted {n} items, freed {bytes}",
    es: "Borraste {n} ítems, liberaste {bytes}",
  },
  "cleanup.failed_suffix": { en: " · {n} failed", es: " · {n} fallaron" },
  "cleanup.scanning_workspace": { en: "Scanning workspace…", es: "Escaneando workspace…" },
  "cleanup.nothing": { en: "Nothing to clean.", es: "Nada para limpiar." },
  "cleanup.items_one": { en: "{n} item · {bytes}", es: "{n} ítem · {bytes}" },
  "cleanup.items_other": { en: "{n} items · {bytes}", es: "{n} ítems · {bytes}" },
  "cleanup.and_more": { en: "… and {n} more", es: "… y {n} más" },

  // Claude view
  "claude.title": { en: "Claude", es: "Claude" },
  "claude.subtitle": {
    en: "Skills available to Claude Code and MCP servers configured on this machine.",
    es: "Skills disponibles para Claude Code y servidores MCP configurados en esta máquina.",
  },
  "claude.refreshing": { en: "Refreshing…", es: "Refrescando…" },
  "claude.refresh": { en: "Refresh", es: "Refrescar" },
  "claude.mcp_title": { en: "MCP servers", es: "Servidores MCP" },
  "claude.mcp_active": { en: "{active} active of {total}", es: "{active} activos de {total}" },
  "claude.mcp_loading": { en: "Loading MCP servers…", es: "Cargando servidores MCP…" },
  "claude.mcp_empty": {
    en: "No MCP servers configured under ~/.claude/mcp/ or settings.json.",
    es: "Sin servidores MCP configurados en ~/.claude/mcp/ ni en settings.json.",
  },
  "claude.mcp_bundled": {
    en: "Bundled plugin — no explicit command.",
    es: "Plugin incluido — sin comando explícito.",
  },
  "claude.mcp_toggle": { en: "Toggle {name}", es: "Activar/desactivar {name}" },
  "claude.skills_title": { en: "Skills", es: "Skills" },
  "claude.skills_count_one": { en: "{n} skill · sorted by recent usage", es: "{n} skill · ordenadas por uso reciente" },
  "claude.skills_count_other": { en: "{n} skills · sorted by recent usage", es: "{n} skills · ordenadas por uso reciente" },
  "claude.skills_loading": { en: "Loading skills…", es: "Cargando skills…" },
  "claude.skills_empty": {
    en: "No skills found in ~/.claude/skills/.",
    es: "Sin skills en ~/.claude/skills/.",
  },
  "claude.no_description": { en: "No description provided.", es: "Sin descripción." },
  "claude.usage_title": {
    en: "{n} mentions in the last 30 days",
    es: "{n} menciones en los últimos 30 días",
  },
  "claude.open": { en: "Open", es: "Abrir" },

  // Companions view
  "companions.title": { en: "Companion", es: "Compañero" },
  "companions.subtitle": {
    en: "Configure the assistant shown in the right panel.",
    es: "Configurá el asistente que aparece en el panel derecho.",
  },
  "companions.identity": { en: "Identity", es: "Identidad" },
  "companions.name": { en: "Name", es: "Nombre" },
  "companions.image": { en: "Image", es: "Imagen" },
  "companions.no_image": { en: "no image", es: "sin imagen" },
  "companions.choose_image": { en: "Choose image", es: "Elegir imagen" },
  "companions.remove": { en: "Remove", es: "Quitar" },
  "companions.image_hint": { en: "PNG, JPG or WebP — up to 2 MB.", es: "PNG, JPG o WebP — hasta 2 MB." },
  "companions.err_not_image": { en: "File is not an image.", es: "El archivo no es una imagen." },
  "companions.err_too_large": {
    en: "Image is over 2 MB. Use a smaller one.",
    es: "La imagen pesa más de 2 MB. Usá una más chica.",
  },
  "companions.err_read": { en: "Could not read file.", es: "No se pudo leer el archivo." },
  "companions.placeholder": { en: "Companion", es: "Compañero" },

  // Sync view extras
  "sync.target_required": { en: "Set a target directory first", es: "Configurá un directorio destino primero" },
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

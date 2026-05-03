// Two-track navigation catalogs.
//   • SIDEBAR_NAV — high-frequency, operational tabs (one click away).
//   • TOPBAR_NAV  — low-frequency, meta tabs (config / introspection).
// The id stays English (canonical state); the label is resolved per render
// via useT() inside the component that consumes the array.

import {
  Activity,
  Bot,
  Boxes,
  Cloud,
  Cog,
  FolderOpen,
  GitPullRequest,
  Home,
  Trash2,
} from "lucide-react";
import type { StringKey } from "../lib/i18n";
import type { V3Tab } from "../v3/v3types";

interface NavEntry {
  id: V3Tab;
  navKey: StringKey;
  Icon: typeof Home;
}

export const SIDEBAR_NAV: NavEntry[] = [
  { id: "overview", navKey: "nav.overview", Icon: Home },
  { id: "projects", navKey: "nav.projects", Icon: FolderOpen },
  { id: "prs", navKey: "nav.prs", Icon: GitPullRequest },
  { id: "audit", navKey: "nav.audit", Icon: Activity },
  { id: "cleanup", navKey: "nav.cleanup", Icon: Trash2 },
];

export const TOPBAR_NAV: NavEntry[] = [
  { id: "claude", navKey: "nav.claude", Icon: Boxes },
  { id: "sync", navKey: "nav.sync", Icon: Cloud },
  { id: "companions", navKey: "nav.companions", Icon: Bot },
  { id: "settings", navKey: "nav.settings", Icon: Cog },
];

// Keyboard shortcuts cover the operational sidebar tabs (Ctrl+1..5). The
// topbar tabs (Claude / Sync / Companion / Settings) are low-frequency —
// Ctrl+, still jumps to Settings; the others are click-only.
export const KEYBOARD_TAB_ORDER: ReadonlyArray<V3Tab> = [
  "overview",
  "projects",
  "prs",
  "audit",
  "cleanup",
];

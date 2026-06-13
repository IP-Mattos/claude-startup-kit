// Two-track navigation catalogs.
//   • SIDEBAR_NAV — high-frequency, operational tabs (one click away).
//   • TOPBAR_NAV  — low-frequency, meta tabs (config / introspection).
// The id stays English (canonical state); the label is resolved per render
// via useT() inside the component that consumes the array.

import {
  Activity,
  Boxes,
  Cog,
  FolderOpen,
  GitPullRequest,
  Home,
  Search,
  Trash2,
} from "lucide-react";
import type { StringKey } from "../lib/i18n";
import type { V3Tab } from "../v3/v3types";

export interface NavEntry {
  id: V3Tab;
  navKey: StringKey;
  Icon: typeof Home;
}

export interface NavSection {
  labelKey: StringKey;
  entries: NavEntry[];
}

// Grouped sidebar — small-caps section headers above each block so 9 tabs
// don't read as one undifferentiated list. The Sidebar component iterates
// these; SIDEBAR_NAV is kept as a flat derivation for code paths (command
// palette, keyboard shortcut order) that don't care about grouping.
export const SIDEBAR_SECTIONS: NavSection[] = [
  {
    labelKey: "nav.section_workspace",
    entries: [
      { id: "overview", navKey: "nav.overview", Icon: Home },
      { id: "projects", navKey: "nav.projects", Icon: FolderOpen },
      { id: "prs", navKey: "nav.prs", Icon: GitPullRequest },
    ],
  },
  {
    labelKey: "nav.section_insights",
    entries: [
      { id: "conversations", navKey: "nav.conversations", Icon: Search },
    ],
  },
  {
    labelKey: "nav.section_work",
    entries: [
      { id: "audit", navKey: "nav.audit", Icon: Activity },
      { id: "cleanup", navKey: "nav.cleanup", Icon: Trash2 },
    ],
  },
];

export const SIDEBAR_NAV: NavEntry[] = SIDEBAR_SECTIONS.flatMap((s) => s.entries);

export const TOPBAR_NAV: NavEntry[] = [
  { id: "claude", navKey: "nav.claude", Icon: Boxes },
  { id: "settings", navKey: "nav.settings", Icon: Cog },
];

// Keyboard shortcuts cover the operational sidebar tabs (Ctrl+1..9). The
// topbar tabs (Claude / Sync / Companion / Settings) are low-frequency —
// Ctrl+, still jumps to Settings; the others are click-only.
export const KEYBOARD_TAB_ORDER: ReadonlyArray<V3Tab> = [
  "overview",
  "projects",
  "prs",
  "conversations",
  "audit",
  "cleanup",
];

export type Project = {
  path: string;
  mtime: number;
  days_ago: number;
  last_date: string;
};

export type GitInfo = {
  hash: string;
  ago: string;
  author: string;
  subject: string;
};

export type AuditFinding = {
  level: "OK" | "INFO" | "WARN" | "CRIT";
  category: string;
  title: string;
  detail: string;
};

export type GhPullRequest = {
  title: string;
  url: string;
  repository: string;
  author: string;
  created_at: string;
};

export type CleanupItem = {
  category: string;
  path: string;
  bytes: number;
  mtime: number;
};

export type CleanupResult = {
  deleted: number;
  failed: number;
  freed_bytes: number;
  errors: string[];
};

export type Tab = "companion" | "projects" | "audit" | "prs" | "cleanup";

export type InsightAction = {
  label: string;
  projectPath?: string;
  url?: string;
};

export type Insight = {
  kind: "info" | "warn" | "praise" | "nudge";
  text: string;
  actions?: InsightAction[];
};

export const THEMES = [
  "kawaii",
  "grid",
  "gameboy",
  "retro-os",
  "hud",
  "petrick",
  "army-cream",
  "y2k",
  "pulse",
  "army-mauve",
  "dracula",
  "mono",
  "solarized-dark",
  "nord",
  "tokyo-night",
  "gruvbox",
  "lilac-os",
  "moon-zine",
  "deepweb",
  "akira",
  "alacritty",
  "crimson-arch",
  "aesthetic-arch",
  "pixel-kit",
  "kill-switch",
  "arcade-portal",
  // v2 — parallel rework (refined contrast, modern layout, smaller companion)
  "kawaii-v2",
  "grid-v2",
  "gameboy-v2",
  "dracula-v2",
  "mono-v2",
  "solarized-dark-v2",
  "nord-v2",
  "tokyo-night-v2",
  "gruvbox-v2",
  "retro-os-v2",
  "hud-v2",
  "petrick-v2",
  "army-cream-v2",
  "y2k-v2",
  "pulse-v2",
  "army-mauve-v2",
  "lilac-os-v2",
  "moon-zine-v2",
  "deepweb-v2",
  "akira-v2",
  "alacritty-v2",
  "crimson-arch-v2",
  "aesthetic-arch-v2",
  "pixel-kit-v2",
  "kill-switch-v2",
  "arcade-portal-v2",
] as const;

export type Theme = (typeof THEMES)[number];

export type ProjectEnrichment = {
  git: GitInfo | null;
  goal: string | null;
};

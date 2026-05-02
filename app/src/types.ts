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
  "lunar",
  "glitch",
  "berserk",
  "ink",
  "occult",
  "grid",
  "gameboy",
  "gba",
  "foxmi",
  "newsprint",
] as const;

export type Theme = (typeof THEMES)[number];

export type ProjectEnrichment = {
  git: GitInfo | null;
  goal: string | null;
};

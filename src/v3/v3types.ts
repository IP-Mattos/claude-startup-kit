// Shared V3 types. Lives at src/v3/v3types.ts so it stays close to the V3
// shell without colliding with the global src/types.ts.

export type V3Tab =
  | "overview"
  | "projects"
  | "prs"
  | "conversations"
  | "audit"
  | "cleanup"
  | "settings"
  | "claude";

// Backend payload returned by the `workspace_summary` Tauri command.
// Both the WorkspaceCard and any future caller share this shape so a Rust
// change shows up as one TS error instead of N drifted copies.
export interface WorkspaceSummary {
  app_version: string;
  gentle_ai_version: string | null;
  engram_sessions: number | null;
  engram_observations: number | null;
  skills_total: number;
  skills_used: number;
}

import { memo } from "react";
import { Folder, FolderOpen, GitBranch, Target } from "lucide-react";
import type { GitInfo, Project } from "../types";
import { activityLabel, hexId, projectName, tierClass } from "../lib/format";
import { FrameCorners } from "./FrameCorners";

export type ProjectRowProps = {
  project: Project;
  index: number;
  git: GitInfo | null;
  goal: string | null;
  onOpenCode: (path: string) => void;
  onOpenExplorer: (path: string) => void;
};

function ProjectRowImpl({ project, index, git, goal, onOpenCode, onOpenExplorer }: ProjectRowProps) {
  return (
    <li
      className={`project ${tierClass(project.days_ago)}`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <span className="tier-strip" aria-hidden="true" />
      <FrameCorners />
      <div className="project-main">
        <div className="project-name">
          <FolderOpen size={16} className="project-icon" />
          {projectName(project.path)}
          <span className="hex-id">0x{hexId(project.path)}</span>
        </div>
        <div className="project-path">
          <span className="path-glyph">▸</span> {project.path}
        </div>
        {goal && (
          <div className="project-line">
            <Target size={12} className="line-icon goal-icon" />
            <span className="goal-text">{goal}</span>
          </div>
        )}
        {git && (
          <div className="project-line">
            <GitBranch size={12} className="line-icon" />
            <span className="git-hash">{git.hash}</span>
            <span className="git-subject">{git.subject}</span>
            <span className="git-ago">· {git.ago}</span>
          </div>
        )}
      </div>
      <div className="project-meta">
        <span className={`badge ${project.days_ago <= 1 ? "badge-fresh" : ""}`}>
          {activityLabel(project.days_ago)}
        </span>
        <span className="date">{project.last_date}</span>
      </div>
      <div className="project-actions">
        <button onClick={() => onOpenCode(project.path)}>Abrir en VS Code</button>
        <button
          className="ghost icon-btn"
          onClick={() => onOpenExplorer(project.path)}
          title="Abrir en Explorer"
        >
          <Folder size={14} />
        </button>
      </div>
    </li>
  );
}

export const ProjectRow = memo(ProjectRowImpl);

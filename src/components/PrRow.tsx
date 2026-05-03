import { memo } from "react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import type { GhPullRequest } from "../types";
import { FrameCorners } from "./FrameCorners";

export type PrRowProps = {
  pr: GhPullRequest;
  index: number;
  onOpen: (url: string) => void;
};

function PrRowImpl({ pr, index, onOpen }: PrRowProps) {
  return (
    <li className="pr" style={{ animationDelay: `${index * 30}ms` }}>
      <FrameCorners />
      <div className="pr-main">
        <div className="pr-title">
          <GitPullRequest size={14} className="pr-icon" />
          {pr.title}
        </div>
        <div className="pr-meta">
          <span className="pr-repo">{pr.repository}</span>
          <span className="dim">·</span>
          <span>by {pr.author}</span>
          <span className="dim">·</span>
          <span>{pr.created_at.slice(0, 10)}</span>
        </div>
      </div>
      <button onClick={() => onOpen(pr.url)}>
        Abrir <ExternalLink size={12} />
      </button>
    </li>
  );
}

export const PrRow = memo(PrRowImpl);

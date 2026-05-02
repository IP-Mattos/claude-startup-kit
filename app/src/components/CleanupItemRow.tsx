import { memo } from "react";
import type { CleanupItem } from "../types";
import { formatBytes, formatDate } from "../lib/format";

export type CleanupItemRowProps = {
  item: CleanupItem;
};

function CleanupItemRowImpl({ item }: CleanupItemRowProps) {
  return (
    <li>
      <span className="cleanup-date">{formatDate(item.mtime)}</span>
      <span className="cleanup-size">{formatBytes(item.bytes)}</span>
      <span className="cleanup-name" title={item.path}>
        {item.path.split(/[\\/]/).pop()}
      </span>
    </li>
  );
}

export const CleanupItemRow = memo(CleanupItemRowImpl);

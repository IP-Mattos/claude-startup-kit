import { memo } from "react";
import type { AuditFinding } from "../types";

export type AuditFindingRowProps = {
  finding: AuditFinding;
};

function AuditFindingRowImpl({ finding }: AuditFindingRowProps) {
  return (
    <li className={"audit-finding lvl-" + finding.level.toLowerCase()}>
      <span className={"audit-level lvl-" + finding.level.toLowerCase()}>{finding.level}</span>
      <div className="audit-body">
        <div className="audit-title">{finding.title}</div>
        {finding.detail && <div className="audit-detail">{finding.detail}</div>}
      </div>
    </li>
  );
}

export const AuditFindingRow = memo(AuditFindingRowImpl);

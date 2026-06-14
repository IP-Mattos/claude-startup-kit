import { useEffect, useState } from "react";
import type { Member } from "../../../lib/trello/types";

// Two-letter initials from a name ("Iván Peña" -> "IP"). Falls back to "?".
function initials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

interface Props {
  member: Member;
  size?: number;
}

// A person's face: the avatar image when it loads, otherwise their initials in
// a tinted circle. Google/Supabase avatar URLs can 403 on referrer, so we send
// no referrer and degrade to initials on error.
export function MemberAvatar({ member, size = 22 }: Props) {
  const [broken, setBroken] = useState(false);
  // Retry the image if the source changes (e.g. a future in-place members
  // refetch swaps a transiently-failed URL for a good one).
  useEffect(() => setBroken(false), [member.avatar_url]);
  const label = member.name ?? "—";
  const showImg = !!member.avatar_url && !broken;

  return (
    <span
      className="v3-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      title={label}
      aria-label={label}
    >
      {showImg ? (
        <img
          src={member.avatar_url ?? ""}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        <span aria-hidden="true">{initials(member.name)}</span>
      )}
    </span>
  );
}

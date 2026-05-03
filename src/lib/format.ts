export function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function activityLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "hoy";
  if (daysAgo === 1) return "ayer";
  return `hace ${daysAgo}d`;
}

// English variant — V3 surfaces user-facing copy in English while V1 stays in
// Rioplatense Spanish.
export function activityLabelEn(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo}d ago`;
}

// FNV-1a hash → 4-byte hex ID. Stable, fast, looks like a memory address.
export function hexId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-4).toUpperCase();
}

// Tier strip color by recency: "fresh" / "warm" / "cool"
export function tierClass(daysAgo: number): string {
  if (daysAgo <= 1) return "tier-fresh";
  if (daysAgo <= 7) return "tier-warm";
  return "tier-cool";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ISO YYYY-MM-DD (locale-agnostic). Same shape for V1 and V3.
export function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

// English variant of friendlyError. V3 surfaces in English; V1 keeps Spanish.
export function friendlyErrorEn(e: unknown): string {
  const raw = String(e ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return "Something went wrong.";
  if (lower.includes("gh") && (lower.includes("not authenticated") || lower.includes("auth"))) {
    return "You need to authenticate with `gh auth login`.";
  }
  if (lower.includes("not found") && lower.includes("command")) {
    return "A required system tool is missing. Check that it's installed and in PATH.";
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return "Permission denied accessing the resource.";
  }
  if (lower.includes("enoent")) {
    return "File or path not found.";
  }
  if (lower.includes("network") || lower.includes("timed out") || lower.includes("timeout")) {
    return "Network problem. Try again in a moment.";
  }
  return raw;
}

// Map raw backend errors to user-friendly Spanish messages.
export function friendlyError(e: unknown): string {
  const raw = String(e ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return "Ocurrió un error desconocido.";
  if (lower.includes("gh") && (lower.includes("not authenticated") || lower.includes("auth"))) {
    return "Necesitás autenticarte con `gh auth login`.";
  }
  if (lower.includes("not found") && lower.includes("command")) {
    return "Falta una herramienta del sistema. Revisá que esté instalada y en PATH.";
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return "Permiso denegado al acceder al recurso.";
  }
  if (lower.includes("enoent")) {
    return "Ruta o archivo no encontrado.";
  }
  if (lower.includes("network") || lower.includes("timed out") || lower.includes("timeout")) {
    return "Problema de red. Probá de nuevo en un momento.";
  }
  return raw;
}

// Extract PR number from a github.com URL — returns null if no /pull/<n> match.
export function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

// Detects "command not found" responses from invoke for graceful feature detection.
export function isCommandNotFound(e: unknown): boolean {
  const lower = String(e ?? "").toLowerCase();
  return (
    lower.includes("command") &&
    (lower.includes("not found") || lower.includes("not allowed") || lower.includes("unknown"))
  );
}

export function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function activityLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "hoy";
  if (daysAgo === 1) return "ayer";
  return `hace ${daysAgo}d`;
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

export function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
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

// Detects "command not found" responses from invoke for graceful feature detection.
export function isCommandNotFound(e: unknown): boolean {
  const lower = String(e ?? "").toLowerCase();
  return (
    lower.includes("command") &&
    (lower.includes("not found") || lower.includes("not allowed") || lower.includes("unknown"))
  );
}

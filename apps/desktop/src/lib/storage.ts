/**
 * Tiny local store: one JSON value per key, kept in localStorage so it
 * survives restarts in both the browser and the Tauri shell. Missing
 * keys, corrupt values, and unavailable storage all read as missing;
 * writes never throw. Shared by project persistence (#132) and the
 * settings screen (#171).
 */

export function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / unavailable storage / quota: staying in memory is fine
  }
}

export function removeJson(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // private mode / unavailable storage
  }
}

import { invoke } from "@tauri-apps/api/core";
import { type DB, normalize } from "./model";

const LS_KEY = "monkeynotes:db";
export const isTauri = "__TAURI_INTERNALS__" in window;

export async function load(): Promise<DB> {
  try {
    const raw = isTauri
      ? await invoke<string | null>("load_db")
      : localStorage.getItem(LS_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch (err) {
    console.error("failed to load notes, starting fresh", err);
    return normalize(null);
  }
}

let pending: DB | null = null;
let timer: number | undefined;
let inflight: Promise<void> = Promise.resolve();

async function write(db: DB): Promise<void> {
  const contents = JSON.stringify(db, null, 1);
  if (isTauri) await invoke("save_db", { contents });
  else localStorage.setItem(LS_KEY, contents);
}

/** Debounced save. Call as often as you like. */
export function save(db: DB): void {
  pending = db;
  clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), 400);
}

/** Write any pending changes now. */
export function flush(): Promise<void> {
  clearTimeout(timer);
  const db = pending;
  pending = null;
  if (db) {
    inflight = inflight
      .then(() => write(db))
      .catch((err) => console.error("failed to save notes", err));
  }
  return inflight;
}

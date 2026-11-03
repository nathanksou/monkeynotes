/**
 * Typing stats, Monkeytype style: words are characters / 5, and only active
 * typing time counts (a pause longer than SESSION_GAP ends a session).
 */
import type { DayStats, StatsData } from "./model";

export const SESSION_GAP = 3000;
/** A session must last this long before it can set the day's best wpm. */
const BEST_MIN_MS = 10_000;
/** Typing at least this many characters keeps a streak alive. */
const STREAK_MIN_CHARS = 50;

export function dayKey(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const wpmOf = (chars: number, ms: number) => (ms > 0 ? chars / 5 / (ms / 60000) : 0);

export class TypingStats {
  private sessionStart = 0;
  private lastKey = 0;
  private sessionChars = 0;
  /** wpm of the most recent session, shown dimmed once you stop typing */
  lastWpm = 0;

  constructor(
    public data: StatsData,
    private now: () => number = () => performance.now(),
  ) {}

  today(): DayStats {
    const key = dayKey();
    return (this.data.days[key] ??= { chars: 0, ms: 0, best: 0 });
  }

  /** Record `chars` inserted characters. */
  type(chars: number): void {
    const now = this.now();
    const day = this.today();
    if (now - this.lastKey > SESSION_GAP) {
      this.sessionStart = now;
      this.sessionChars = 0;
    } else {
      day.ms += now - this.lastKey;
    }
    this.sessionChars += chars;
    day.chars += chars;
    this.lastKey = now;
    const elapsed = now - this.sessionStart;
    if (elapsed >= 2000) this.lastWpm = Math.round(wpmOf(this.sessionChars, elapsed));
    if (elapsed >= BEST_MIN_MS) day.best = Math.max(day.best, this.lastWpm);
  }

  /** Current session wpm, or null when not typing right now. */
  live(): number | null {
    const now = this.now();
    if (now - this.lastKey > SESSION_GAP || this.lastKey - this.sessionStart < 2000) return null;
    return this.lastWpm;
  }

  /** Days in a row (ending today, or yesterday if today hasn't started) with some typing. */
  streak(): number {
    const d = new Date();
    let count = 0;
    if ((this.data.days[dayKey(d)]?.chars ?? 0) < STREAK_MIN_CHARS) d.setDate(d.getDate() - 1);
    while ((this.data.days[dayKey(d)]?.chars ?? 0) >= STREAK_MIN_CHARS) {
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }

  /** Average wpm over the last `days` days of active typing. */
  average(days = 30): number {
    let chars = 0;
    let ms = 0;
    const d = new Date();
    for (let i = 0; i < days; i++) {
      const s = this.data.days[dayKey(d)];
      if (s) {
        chars += s.chars;
        ms += s.ms;
      }
      d.setDate(d.getDate() - 1);
    }
    return Math.round(wpmOf(chars, ms));
  }

  totals(): { words: number; ms: number; best: number; days: number } {
    let chars = 0;
    let ms = 0;
    let best = 0;
    let days = 0;
    for (const s of Object.values(this.data.days)) {
      chars += s.chars;
      ms += s.ms;
      best = Math.max(best, s.best);
      if (s.chars > 0) days++;
    }
    return { words: Math.round(chars / 5), ms, best, days };
  }

  /** The last `n` days, oldest first. */
  recent(n: number): { key: string; day: Date; stats: DayStats | undefined }[] {
    const out = [];
    const d = new Date();
    d.setDate(d.getDate() - (n - 1));
    for (let i = 0; i < n; i++) {
      const key = dayKey(d);
      out.push({ key, day: new Date(d), stats: this.data.days[key] });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

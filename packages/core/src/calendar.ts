const HOLIDAYS: Record<number, Set<string>> = {
  2026: new Set(["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"]),
  2027: new Set(["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"]),
};
const EARLY: Record<number, Set<string>> = {
  2026: new Set(["11-27", "12-24"]), 2027: new Set(["11-26"]),
};
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(time: number): Record<string, number> {
  return Object.fromEntries(formatter.formatToParts(new Date(time * 1000))
    .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function dateKey(input: string | Date | number): string {
  if (typeof input === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new Error("invalid date");
    const parsed = new Date(input + "T12:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) throw new Error("invalid date");
    return input;
  }
  const seconds = input instanceof Date ? input.getTime() / 1000 : input;
  if (!Number.isFinite(seconds)) throw new Error("invalid time");
  const p = parts(seconds);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function checked(key: string): number {
  const year = Number(key.slice(0, 4));
  if (!HOLIDAYS[year]) throw new Error("calendar year unavailable");
  return year;
}

export function isTradingDay(date: string | Date | number): boolean {
  const key = dateKey(date), year = checked(key);
  const day = new Date(key + "T12:00:00Z").getUTCDay();
  return day !== 0 && day !== 6 && !HOLIDAYS[year].has(key.slice(5));
}

function localTime(key: string, hour: number, minute = 0): number {
  const [y, m, d] = key.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
    guess += target - represented;
  }
  return guess;
}

function addDays(key: string, days: number): string {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sessions(from: number, to: number): [number, number, number][] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error("invalid interval");
  const start = dateKey(from), end = dateKey(to);
  checked(start); checked(end);
  const found: [number, number, number][] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const year = checked(date);
    if (isTradingDay(date)) {
      const session: [number, number, number] = [localTime(date, 9, 30), localTime(date, 10), localTime(date, EARLY[year].has(date.slice(5)) ? 13 : 16)];
      if (session[2] >= from && session[0] <= to) found.push(session);
    }
  }
  return found;
}

export function nextDecision(now: number): number {
  if (!Number.isFinite(now)) throw new Error("invalid time");
  for (let date = dateKey(now); ; date = addDays(date, 1)) {
    checked(date);
    if (isTradingDay(date)) {
      const decision = localTime(date, 10);
      if (decision > now) return decision;
    }
  }
}

export function clockNow(now: number, timezone: string) {
  return { utc: new Date(now).toISOString(), timezone, local: new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "long", hour12: false }).format(now) };
}

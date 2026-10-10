// Input timestamps and time zones have already passed the shared exact interval schemas.
export function spokenInterval(startsAt: string, endsAt: string, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  });
  return `${formatter.format(new Date(startsAt))} through ${formatter.format(new Date(endsAt))}, ${timeZone} time`;
}

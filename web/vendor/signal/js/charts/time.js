/**
 * A small Chart.js date adapter on the platform clock and Intl, so the
 * time axis needs no date library. Format tokens: yyyy MMM MM M dd d
 * HH H hh h mm ss SSS a.
 */
const MS = { millisecond: 1, second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 };
const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleString("en", { month: "short" }));
const pad = (n, w = 2) => String(n).padStart(w, "0");

export function formatTime(time, pattern) {
  const d = new Date(time);
  const h = d.getHours();
  const tokens = {
    yyyy: d.getFullYear(),
    MMM: MONTHS[d.getMonth()],
    MM: pad(d.getMonth() + 1),
    M: d.getMonth() + 1,
    dd: pad(d.getDate()),
    d: d.getDate(),
    HH: pad(h),
    H: h,
    hh: pad(h % 12 || 12),
    h: h % 12 || 12,
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    SSS: pad(d.getMilliseconds(), 3),
    a: h < 12 ? "am" : "pm",
  };
  return pattern.replace(/yyyy|MMM|MM|M|dd|d|HH|H|hh|h|mm|ss|SSS|a/g, (t) => tokens[t]);
}

function startOf(time, unit, weekday = 0) {
  const d = new Date(time);
  switch (unit) {
    case "second": d.setMilliseconds(0); break;
    case "minute": d.setSeconds(0, 0); break;
    case "hour": d.setMinutes(0, 0, 0); break;
    case "day": d.setHours(0, 0, 0, 0); break;
    case "isoWeek":
    case "week": {
      d.setHours(0, 0, 0, 0);
      const start = unit === "isoWeek" ? (weekday === true ? 1 : +weekday || 1) : 0;
      d.setDate(d.getDate() - ((d.getDay() - start + 7) % 7));
      break;
    }
    case "month": d.setHours(0, 0, 0, 0); d.setDate(1); break;
    case "quarter": d.setHours(0, 0, 0, 0); d.setDate(1); d.setMonth(d.getMonth() - (d.getMonth() % 3)); break;
    case "year": d.setHours(0, 0, 0, 0); d.setMonth(0, 1); break;
  }
  return d.getTime();
}

function add(time, amount, unit) {
  const d = new Date(time);
  if (unit === "month") d.setMonth(d.getMonth() + amount);
  else if (unit === "quarter") d.setMonth(d.getMonth() + amount * 3);
  else if (unit === "year") d.setFullYear(d.getFullYear() + amount);
  else return time + amount * MS[unit];
  return d.getTime();
}

export const timeAdapter = {
  formats: () => ({
    datetime: "MMM d, h:mm:ss a",
    millisecond: "h:mm:ss.SSS a",
    second: "h:mm:ss a",
    minute: "h:mm a",
    hour: "h a",
    day: "MMM d",
    week: "MMM d",
    month: "MMM yyyy",
    quarter: "MMM yyyy",
    year: "yyyy",
  }),
  parse: (value) => (value == null ? null : value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value) || null),
  format: (time, pattern) => formatTime(time, pattern),
  add,
  diff: (max, min, unit) => {
    if (unit === "month" || unit === "quarter" || unit === "year") {
      const a = new Date(max);
      const b = new Date(min);
      const months = (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth();
      return unit === "month" ? months : unit === "quarter" ? Math.trunc(months / 3) : Math.trunc(months / 12);
    }
    return (max - min) / MS[unit === "isoWeek" ? "week" : unit];
  },
  startOf,
  endOf: (time, unit) => add(startOf(time, unit), 1, unit === "isoWeek" ? "week" : unit) - 1,
};

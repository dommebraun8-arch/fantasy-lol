/**
 * Kleinkram, den mehrere Module brauchen: Antworten, IDs, Rundenrechnung.
 */

export const ROLES = ["top", "jungle", "mid", "bottom", "support"];
export const ROLE_LABELS = { top: "Top", jungle: "Jungle", mid: "Mid", bottom: "Bot", support: "Support" };

/** Runde: Montag 12:00 bis Montag 12:00, feste Zeitzone Europe/Berlin. */
export const ROUND_TZ = "Europe/Berlin";
const ROUND_HOUR = 12;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export function newId(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Einladungscodes werden vorgelesen und abgetippt - deshalb ohne 0/O/1/I. */
export function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map(b => alphabet[b % alphabet.length]).join("");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verschiebung von Europe/Berlin gegenüber UTC (in Minuten) zum Zeitpunkt ms.
 * Workers haben volle ICU-Daten, deshalb reicht Intl - keine Tabelle mit
 * Sommerzeitregeln nötig.
 */
function tzOffsetMinutes(ms) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ROUND_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Zeitstempel (ms) -> Datumsfelder in Berliner Zeit. */
function berlinParts(ms) {
  const offset = tzOffsetMinutes(ms);
  const shifted = new Date(ms + offset * 60000);
  return {
    offset,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: (shifted.getUTCDay() + 6) % 7, // 0 = Montag
    hour: shifted.getUTCHours(),
  };
}

function isoWeekKey(year, month, day) {
  const t = Date.UTC(year, month, day);
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Donnerstag derselben ISO-Woche
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Runde, in der ein Zeitpunkt liegt.
 * Gibt { key, start, end } in Sekunden zurück.
 */
export function roundFor(ms = Date.now()) {
  const p = berlinParts(ms);
  // Montag 12:00 der laufenden Woche, ausgedrückt in UTC-Millisekunden.
  let startUTC = Date.UTC(p.year, p.month, p.day, ROUND_HOUR, 0, 0) - p.offset * 60000;
  startUTC -= p.weekday * 86400000;
  if (startUTC > ms) startUTC -= 7 * 86400000;
  // Über die Zeitumstellung hinweg kann die Verschiebung am Rundenstart eine
  // andere sein als jetzt - deshalb einmal nachziehen.
  const startParts = berlinParts(startUTC);
  if (startParts.offset !== p.offset) {
    startUTC = Date.UTC(startParts.year, startParts.month, startParts.day, ROUND_HOUR, 0, 0)
      - startParts.offset * 60000;
    if (startUTC > ms) startUTC -= 7 * 86400000;
  }
  const endParts = berlinParts(startUTC + 7 * 86400000);
  const endUTC = Date.UTC(endParts.year, endParts.month, endParts.day, ROUND_HOUR, 0, 0)
    - endParts.offset * 60000;

  const s = berlinParts(startUTC);
  return {
    key: isoWeekKey(s.year, s.month, s.day),
    start: Math.floor(startUTC / 1000),
    end: Math.floor(endUTC / 1000),
  };
}

export function isRoundKey(v) {
  return typeof v === "string" && /^\d{4}-W\d{2}$/.test(v);
}

export function clean(v, maxLen = 64) {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen ? v : null;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

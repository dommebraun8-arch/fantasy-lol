/**
 * Reine Rechenlogik, ohne Server und ohne Datenbank.
 *
 * Zwei Dinge stehen hier, weil sie sonst niemand prueft:
 *
 *  - Die Rundengrenzen (Montag 12:00 Berlin) inklusive beider
 *    Zeitumstellungen. Daran haengen Sperren, Preise und Wertung.
 *  - Die Obergrenze des Passwort-Hashings. Die Workers-Runtime lehnt mehr als
 *    100.000 Runden ab, der lokale workerd aber nicht - ohne diese Zusicherung
 *    faellt eine zu hohe Zahl erst im echten Deploy auf. Genau so ist es
 *    passiert.
 */

import { roundFor } from "../src/util.js";
import { pbkdf2Rounds } from "../src/auth.js";

let fails = 0;
const check = (label, cond, extra) => {
  console.log((cond ? "  OK   " : "  FAIL ") + label
    + (!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
};

const berlin = sec => new Date(sec * 1000).toLocaleString("de-DE", {
  timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit",
  year: "numeric", hour: "2-digit", minute: "2-digit",
});
const at = s => new Date(s).getTime();

console.log("\n== Rundengrenzen ==");
let r = roundFor(at("2026-02-11T09:00:00Z"));            // Mittwoch
check("Runde beginnt Montag 12:00", berlin(r.start).includes("09.02.2026, 12:00"), berlin(r.start));
check("Schluessel ist die Kalenderwoche", r.key === "2026-W07", r.key);
check("Runde endet Montag 12:00", berlin(r.end).includes("16.02.2026, 12:00"), berlin(r.end));

r = roundFor(at("2026-02-09T10:59:00Z"));                 // Mo 11:59 Berlin
check("Montag 11:59 zaehlt zur Vorwoche", berlin(r.start).includes("02.02.2026"), berlin(r.start));
r = roundFor(at("2026-02-09T11:00:00Z"));                 // Mo 12:00 Berlin
check("Montag 12:00 startet die neue Runde", berlin(r.start).includes("09.02.2026"), berlin(r.start));

r = roundFor(at("2026-03-29T12:00:00Z"));                 // Sommerzeit beginnt
check("Umstellung vor: Start Mo 12:00", berlin(r.start).includes("23.03.2026, 12:00"), berlin(r.start));
check("Umstellung vor: Ende Mo 12:00", berlin(r.end).includes("30.03.2026, 12:00"), berlin(r.end));
check("Umstellung vor: eine Stunde kuerzer", r.end - r.start === 7 * 86400 - 3600, (r.end - r.start) / 3600);

r = roundFor(at("2026-10-25T12:00:00Z"));                 // Sommerzeit endet
check("Umstellung zurueck: Start Mo 12:00", berlin(r.start).includes("19.10.2026, 12:00"), berlin(r.start));
check("Umstellung zurueck: eine Stunde laenger", r.end - r.start === 7 * 86400 + 3600, (r.end - r.start) / 3600);

let t = at("2026-01-05T12:00:00Z"), prev = null, gaps = 0;
const keys = new Set();
for (let i = 0; i < 60; i++) {
  const cur = roundFor(t);
  if (prev && cur.start !== prev.end) gaps++;
  keys.add(cur.key);
  prev = cur;
  t = cur.end * 1000 + 1000;
}
check("Runden schliessen lueckenlos an", gaps === 0, gaps);
check("Jede Runde hat einen eigenen Schluessel", keys.size === 60, keys.size);

console.log("\n== Passwort-Hashing ==");
check("Standard ist das erlaubte Maximum", pbkdf2Rounds({}) === 100000, pbkdf2Rounds({}));
check("Zu hoher Wert wird geklemmt", pbkdf2Rounds({ PBKDF2_ROUNDS: "500000" }) === 100000,
  pbkdf2Rounds({ PBKDF2_ROUNDS: "500000" }));
check("Niedrigerer Wert wird uebernommen", pbkdf2Rounds({ PBKDF2_ROUNDS: "20000" }) === 20000);
check("Unsinn faellt auf den Standard zurueck", pbkdf2Rounds({ PBKDF2_ROUNDS: "abc" }) === 100000);
check("Laecherlich kleine Werte werden ignoriert", pbkdf2Rounds({ PBKDF2_ROUNDS: "5" }) === 100000);
check("Ohne env geht es auch", pbkdf2Rounds(undefined) === 100000);
// Die eigentliche Zusicherung: was auch immer konfiguriert wird, die Runtime
// nimmt es an.
for (const value of ["100001", "1000000", "99999999"]) {
  check(`PBKDF2_ROUNDS=${value} bleibt unter der Runtime-Grenze`,
    pbkdf2Rounds({ PBKDF2_ROUNDS: value }) <= 100000);
}

console.log(fails ? `\n${fails} FEHLER` : "\nALLE EINHEITSTESTS BESTANDEN");
process.exit(fails ? 1 : 0);

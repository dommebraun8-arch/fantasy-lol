/**
 * Durchlauf der Oberflaeche im echten Browser gegen den lokalen Worker.
 * Zwei Nutzer in getrennten Browser-Kontexten - so laesst sich pruefen, dass
 * der eine den Kader des anderen wirklich erst sieht, wenn er selbst steht.
 */

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const BASE = process.env.TEST_BASE || "http://127.0.0.1:8787";
const SHOTS = process.env.TEST_SHOTS || "/tmp/fantasy-shots";
const uniq = Math.random().toString(36).slice(2, 7);

let fails = 0;
const check = (label, cond, extra) => {
  console.log((cond ? "  OK   " : "  FAIL ") + label
    + (!cond && extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 300) : ""));
  if (!cond) fails++;
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

async function newUser(name, viewport) {
  const context = await browser.newContext({ viewport, locale: "de-DE", timezoneId: "Europe/Berlin" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => {
    const t = m.text();
    // Verstoesse gegen die CSP tauchen als console-Fehler auf - die will ich sehen.
    if (m.type() === "error" && !/favicon/.test(t)) errors.push("console: " + t);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#auth-form");
  await page.click("#auth-switch");
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="password"]', "geheim12345");
  await page.click('button[type="submit"]');
  return { page, context, errors };
}

const phone = { width: 390, height: 844 };
const a = await newUser("Domi" + uniq, phone);
const b = await newUser("Lisa" + uniq, phone);

console.log("\n== Anmeldung und Lobby ==");
await a.page.waitForSelector("#create-form");
check("Nach der Registrierung kommt die Lobby", await a.page.locator("#create-form").count() === 1);
check("Name steht in der Kopfzeile", (await a.page.locator("#who").innerText()).includes("Domi"),
  await a.page.locator("#who").innerText());

await a.page.fill('#create-form input[name="name"]', "Kleena-Liga");
await a.page.click('#create-form button');
await a.page.waitForSelector(".spot");
check("Liga anlegen fuehrt direkt in den Kader", await a.page.locator(".spot").count() === 5);
check("Reiterleiste ist sichtbar", await a.page.locator("#tabs button").count() === 4);

const code = (await a.page.locator(".code").innerText()).trim();
check("Einladungscode wird angezeigt", /^[A-Z2-9]{8}$/.test(code), code);
await a.page.screenshot({ path: SHOTS + "/1-kader-leer.png", fullPage: true });

console.log("\n== Beitreten ==");
await b.page.waitForSelector("#join-form");
await b.page.fill('#join-form input[name="code"]', code.toLowerCase());
await b.page.click("#join-form button");
await b.page.waitForSelector(".spot");
check("Beitritt per Code fuehrt in dieselbe Liga",
  (await b.page.locator(".card h2").first().innerText()).includes("Kleena-Liga"),
  await b.page.locator(".card h2").first().innerText());
check("Gast sieht keinen Einladungscode", await b.page.locator(".code").count() === 0);

console.log("\n== Kader zusammenstellen ==");
async function pickCheapest(page, role) {
  await page.click(`[data-pick="${role}"]`);
  await page.waitForSelector("#sheet.open .prow");
  const rows = page.locator("#sheet .prow:not(.off)");
  const n = await rows.count();
  let idx = -1, best = Infinity;
  for (let i = 0; i < n; i++) {
    const price = parseFloat(await rows.nth(i).locator(".num b").innerText());
    if (price < best) { best = price; idx = i; }
  }
  if (idx < 0) return false;
  await rows.nth(idx).click();
  await page.waitForSelector("#sheet.open", { state: "detached", timeout: 5000 });
  await page.waitForTimeout(150);
  return true;
}

await a.page.click('[data-pick="mid"]');
await a.page.waitForSelector("#sheet.open .prow");
check("Auswahl zeigt nur Midlaner",
  (await a.page.locator("#sheet .prow").count()) === 4, await a.page.locator("#sheet .prow").count());
const lockedRow = a.page.locator("#sheet .prow.off").first();
check("Gesperrtes Team ist nicht waehlbar",
  (await lockedRow.count()) === 1 && (await lockedRow.innerText()).includes("gespielt"),
  await lockedRow.innerText().catch(() => "keine"));
check("Restbudget steht im Kopf",
  /Noch\s+35\.0\s+von\s+35\.0/.test((await a.page.locator("#sheet-sub").innerText()).replace(/\s+/g, " ")),
  await a.page.locator("#sheet-sub").innerText());
await a.page.screenshot({ path: SHOTS + "/2-auswahl.png" });
await a.page.keyboard.press("Escape");
await a.page.waitForTimeout(250);

for (const role of ["top", "jungle", "mid", "bottom", "support"]) {
  check(`Platz ${role} laesst sich besetzen`, await pickCheapest(a.page, role));
}
const cost = parseFloat((await a.page.locator(".budget .num").innerText()).split("/")[0]);
check("Kosten bleiben im Budget", cost > 0 && cost <= 35, cost);
check("Kein Hinweis auf freie Plaetze mehr",
  !(await a.page.locator("#app").innerText()).includes("Plätze frei"));

console.log("\n== Kapitaen ==");
await a.page.click('[data-cap="mid"]');
await a.page.waitForTimeout(300);
check("Kapitaensplatz ist markiert", await a.page.locator(".spot.cap").count() === 1);
check("Knopf zeigt den Zustand",
  await a.page.locator('[data-cap="mid"].on').count() === 1);
check("Alle fuenf Lanes stehen auf der Karte",
  await a.page.locator(".rift .spot").count() === 5);
await a.page.screenshot({ path: SHOTS + "/3-kader-voll.png", fullPage: true });

console.log("\n== Budgetgrenze in der Oberflaeche ==");
// Teuersten Midlaner holen, danach muessen andere Plaetze eng werden.
await a.page.click('[data-pick="mid"]');
await a.page.waitForSelector("#sheet.open .prow");
const priced = a.page.locator("#sheet .prow:not(.off)");
let maxIdx = -1, maxPrice = -1;
for (let i = 0; i < await priced.count(); i++) {
  const p = parseFloat(await priced.nth(i).locator(".num b").innerText());
  if (p > maxPrice) { maxPrice = p; maxIdx = i; }
}
await priced.nth(maxIdx).click();
await a.page.waitForSelector("#sheet.open", { state: "detached" });
await a.page.waitForTimeout(200);
const cost2 = parseFloat((await a.page.locator(".budget .num").innerText()).split("/")[0]);
check("Teurerer Spieler erhoeht die Kosten", cost2 > cost, { cost, cost2 });
check("Budget bleibt eingehalten", cost2 <= 35, cost2);

console.log("\n== Verdeckt, bis der eigene Kader steht ==");
await b.page.click('#tabs [data-tab="points"]');
await b.page.waitForTimeout(400);
let bText = await b.page.locator("#app").innerText();
check("B sieht As Kader nicht", bText.includes("Verdeckt"), bText.slice(0, 200));
check("B sieht As Punktestand trotzdem", /Punktestand/.test(bText));

for (const role of ["top", "jungle", "mid", "bottom", "support"]) {
  await b.page.click('#tabs [data-tab="squad"]');
  await b.page.waitForTimeout(150);
  await pickCheapest(b.page, role);
}
await b.page.click('#tabs [data-tab="points"]');
await b.page.waitForTimeout(500);
bText = await b.page.locator("#app").innerText();
check("Nach eigenem Kader ist As Kader offen", !bText.includes("Verdeckt"), bText.slice(0, 200));
await b.page.screenshot({ path: SHOTS + "/4-punkte.png", fullPage: true });

console.log("\n== Punkte und Tabelle ==");
await a.page.click('#tabs [data-tab="points"]');
await a.page.waitForTimeout(500);
const rows = await a.page.locator("#app table.tbl tbody tr").allInnerTexts();
check("Punkteansicht listet fuenf Plaetze", rows.length >= 5, rows.length);
// Ueber die Zellen gehen, nicht ueber den Zeilentext: in der ersten Spalte
// stehen zusaetzlich die einzelnen Spielzeilen, die den Text zerlegen.
const capRow = a.page.locator("#app table.tbl tbody tr", { hasText: "×2" }).first();
check("Kapitaen ist mit x2 markiert", await capRow.count() === 1);
if (await capRow.count()) {
  const cells = await capRow.locator("td").allInnerTexts();
  const roh = parseFloat(cells[cells.length - 2]);
  const ges = parseFloat(cells[cells.length - 1]);
  check("Kapitaenspunkte sind der doppelte Rohwert",
    Number.isFinite(roh) && Math.abs(ges - roh * 2) < 0.15, { cells, roh, ges });
}

await a.page.click('#tabs [data-tab="table"]');
await a.page.waitForTimeout(500);
const tableText = await a.page.locator("#app").innerText();
check("Tabelle listet beide Manager",
  tableText.includes("Domi" + uniq) && tableText.includes("Lisa" + uniq), tableText.slice(0, 200));
await a.page.screenshot({ path: SHOTS + "/5-tabelle.png", fullPage: true });

console.log("\n== Markt ==");
await a.page.click('#tabs [data-tab="market"]');
await a.page.waitForSelector("#market-q");
check("Markt listet Spieler", await a.page.locator("[data-market]").count() >= 15);
await a.page.click('[data-mrole="support"]');
await a.page.waitForTimeout(200);
const roleRows = await a.page.locator("[data-market]").allInnerTexts();
check("Rollenfilter greift", roleRows.every(t => t.includes("Support")), roleRows.slice(0, 2));
await a.page.fill("#market-q", "SOO");
await a.page.waitForTimeout(200);
check("Suche greift", (await a.page.locator("[data-market]").allInnerTexts()).every(t => t.includes("SOO")));
check("Suchfeld behaelt den Fokus",
  await a.page.evaluate(() => document.activeElement && document.activeElement.id) === "market-q");

// Sortieren: die Preisspalte muss auf- und absteigend wirklich umsortieren.
await a.page.click('[data-mrole=""]');
await a.page.fill("#market-q", "");
await a.page.waitForTimeout(200);
const priceCol = async () => (await a.page.locator("table.market tbody tr")
  .evaluateAll(rows => rows.map(r => parseFloat(r.querySelectorAll("td.num")[0].textContent))));
let col = await priceCol();
check("Markt startet nach Preis absteigend",
  col.length > 2 && col.every((v, i) => i === 0 || col[i - 1] >= v), col.slice(0, 5));
await a.page.click('[data-msort="price"]');
await a.page.waitForTimeout(200);
col = await priceCol();
check("Nochmal klicken dreht die Richtung um",
  col.every((v, i) => i === 0 || col[i - 1] <= v), col.slice(0, 5));

await a.page.click('[data-msort="picked"]');
await a.page.waitForTimeout(200);
const marketText = await a.page.locator("table.market").innerText();
check("Spalte Gewaehlt zeigt Prozent", /\d+ %/.test(marketText), marketText.slice(0, 200));
const pickedCol = await a.page.locator("table.market tbody tr")
  .evaluateAll(rows => rows.map(r => parseInt(r.querySelectorAll("td.num")[3].textContent)));
check("Nach Gewaehlt sortiert stehen die beliebtesten oben",
  pickedCol[0] > 0 && pickedCol.every((v, i) => i === 0 || pickedCol[i - 1] >= v), pickedCol.slice(0, 5));
await a.page.screenshot({ path: SHOTS + "/6-markt.png", fullPage: true });

console.log("\n== Rechenweg der Punkte ==");
// Der einzige Spieler mit echten Spielzeilen im Testbestand ist SOO-mid.
await a.page.click('[data-mrole="mid"]');
await a.page.fill("#market-q", "SOO");
await a.page.waitForTimeout(250);
check("Markt-Zeile laesst sich anklicken", await a.page.locator("[data-market]").count() === 1,
  await a.page.locator("[data-market]").count());
await a.page.click("[data-market]");
await a.page.waitForTimeout(400);
await a.page.click('#tabs [data-tab="points"]');
await a.page.waitForTimeout(500);

const heads = a.page.locator(".line-head");
check("Beide Spiele stehen einzeln da", await heads.count() === 2, await heads.count());
check("Details sind zugeklappt", await a.page.locator(".line-detail:visible").count() === 0);
await heads.first().click();
await a.page.waitForTimeout(150);
const detail = a.page.locator(".line-detail:visible").first();
check("Ein Tipp klappt den Rechenweg auf", await detail.count() === 1);
const detailText = await detail.innerText();
for (const [label, expect] of [
  ["Kills", "+10,0"], ["Assists", "+10,5"], ["Tode", "−0,5"],
  ["Creep Score", "+6,0"], ["Serien-Sieg", "+3,0"],
]) {
  check(`Rechenweg nennt ${label} mit ${expect}`,
    detailText.includes(label) && detailText.includes(expect), detailText);
}
check("Die Summe steht darunter", /Summe\s+29\.0/.test(detailText.replace(/\s+/g, " ")), detailText);
check("Kein Hinweis auf eine alte Formel", !detailText.includes("geändert"), detailText);

// Zweite Zeile: 7.0 gespeichert, die Formel ergaebe 12.0 - der Hinweis muss kommen.
await heads.nth(1).click();
await a.page.waitForTimeout(150);
const drift = await a.page.locator(".line-detail:visible").nth(1).innerText();
check("Kein Tod bringt Punkte", drift.includes("Kein Tod"), drift);
check("Abweichende Formel wird benannt", drift.includes("geändert"), drift);
await a.page.screenshot({ path: SHOTS + "/8-rechenweg.png", fullPage: true });

await heads.first().click();
await a.page.waitForTimeout(150);
check("Nochmal tippen klappt wieder zu", await a.page.locator(".line-detail:visible").count() === 1,
  await a.page.locator(".line-detail:visible").count());

console.log("\n== Sitzung ueberdauert das Neuladen ==");
await a.page.reload({ waitUntil: "domcontentloaded" });
await a.page.waitForSelector(".spot");
check("Nach dem Neuladen ist man noch angemeldet", await a.page.locator(".spot").count() === 5);
check("Kader ist noch da", await a.page.locator(".spot.cap").count() === 1);

console.log("\n== Abmelden ==");
await a.page.click("#switch-league");
await a.page.waitForSelector("#logout");
await a.page.click("#logout");
await a.page.waitForSelector("#auth-form");
check("Abmelden fuehrt zum Login", await a.page.locator("#auth-form").count() === 1);
await a.page.reload({ waitUntil: "domcontentloaded" });
await a.page.waitForSelector("#auth-form");
check("Sitzung ist wirklich beendet", await a.page.locator("#auth-form").count() === 1);

console.log("\n== Darstellung ==");
const overflow = await b.page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("Kein waagerechtes Scrollen am Telefon", overflow <= 1, overflow);
// Der Markt hat vier Zahlenspalten - passen sie nicht, scrollt er in sich.
// Am Telefon darf davon aber nichts abgeschnitten sein, sonst sieht man die
// interessanteste Spalte ("Gewählt") nie.
await b.page.click('#tabs [data-tab="market"]');
await b.page.waitForSelector("table.market");
const cut = await b.page.evaluate(() => {
  const t = document.querySelector("table.market");
  return t.scrollWidth - t.closest(".tscroll").clientWidth;
});
check("Markttabelle passt aufs Telefon", cut <= 0, cut);
await b.page.click('#tabs [data-tab="squad"]');
await b.page.waitForSelector(".spot");
const collide = await b.page.evaluate(() => [...document.querySelectorAll(".spot")].filter(s => {
  const r = s.querySelector(".spot-role").getBoundingClientRect();
  const p = s.querySelector(".spot-pts").getBoundingClientRect();
  return r.right > p.left + 0.5;
}).map(s => s.className));
check("Rolle und Punktzahl ueberlappen nicht", collide.length === 0, collide);
// Am Schreibtisch soll dieselbe Ansicht die Breite auch nutzen - dieselbe
// Sitzung wie B, nur in einem grossen Fenster.
const wide = await b.context.newPage();
await wide.setViewportSize({ width: 1280, height: 900 });
await wide.goto(BASE);
await wide.waitForSelector(".spot");
await wide.screenshot({ path: SHOTS + "/7-desktop-kader.png", fullPage: true });
await wide.click('#tabs [data-tab="market"]');
await wide.waitForSelector("table.market");
check("Am Schreibtisch steht auch der Schnitt in der Tabelle",
  await wide.locator("table.market thead th.opt:visible").count() === 1);
await wide.screenshot({ path: SHOTS + "/7b-desktop-markt.png", fullPage: true });
const wideOverflow = await wide.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check("Kein waagerechtes Scrollen am Schreibtisch", wideOverflow <= 1, wideOverflow);
// Am Schreibtisch sitzt das Auswahlblatt nicht am unteren Rand, sondern
// schwebt - zugeklappt muss es trotzdem komplett aus dem Bild sein, sonst
// liegt es ueber der Reiterleiste.
const sheetTop = await wide.evaluate(() =>
  Math.round(document.getElementById("sheet").getBoundingClientRect().top - window.innerHeight));
check("Zugeklapptes Auswahlblatt liegt unter dem Bildrand", sheetTop >= 0, sheetTop);

const wp = await browser.newPage();
await wp.goto(BASE);
await wp.waitForSelector("#auth-form");
await wp.screenshot({ path: SHOTS + "/7c-desktop-login.png" });

console.log("\n== Fehlerfreiheit ==");
check("Keine JS-Fehler bei A", a.errors.length === 0, a.errors);
check("Keine JS-Fehler bei B", b.errors.length === 0, b.errors);

await browser.close();
console.log(fails ? `\n${fails} FEHLER` : "\nALLE UI-TESTS BESTANDEN");
process.exit(fails ? 1 : 0);

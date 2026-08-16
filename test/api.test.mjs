/**
 * Integrationstests gegen einen laufenden `wrangler dev --local`.
 *
 * Kein Mock: echter Worker, echte D1. Gestartet wird der Server von
 * test/run.mjs, das anschliessend diese Datei ausfuehrt.
 */

const BASE = process.env.TEST_BASE || "http://127.0.0.1:8787";
const INGEST_TOKEN = process.env.TEST_INGEST_TOKEN || "testtoken123";

let fails = 0;
let section = "";

export function heading(name) {
  section = name;
  console.log("\n== " + name + " ==");
}

export function check(label, cond, extra) {
  const line = (cond ? "  OK   " : "  FAIL ") + label;
  console.log(cond || extra === undefined ? line : line + "  -> " + JSON.stringify(extra).slice(0, 400));
  if (!cond) fails++;
}

/** Winziger Cookie-Behaelter, damit mehrere Nutzer parallel angemeldet sein koennen. */
class Client {
  constructor(name) { this.name = name; this.cookie = null; }

  async req(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const value = setCookie.split(";")[0];
      this.cookie = value.endsWith("=") ? null : value;
    }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 200) }; } }
    return { status: res.status, data, headers: res.headers };
  }

  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b); }
  put(p, b) { return this.req("PUT", p, b); }
}

async function ingest(part, rows, extra = {}) {
  const res = await fetch(BASE + "/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + INGEST_TOKEN },
    body: JSON.stringify({ part, rows, ...extra }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const ROLES = ["top", "jungle", "mid", "bottom", "support"];
const uniq = Math.random().toString(36).slice(2, 8);

async function main() {
  // ------------------------------------------------------------ Statistikdaten
  const meta = await (await fetch(BASE + "/api/me")).json();
  const round = meta.round;
  const now = Math.floor(Date.now() / 1000);

  // Vier Teams: LOCK hat schon gespielt, die anderen erst spaeter.
  const teams = [
    { id: "t-lock", code: "LCK", first: now - 3600 },
    { id: "t-soon", code: "SOO", first: now + 7200 },
    { id: "t-late", code: "LAT", first: now + 86400 },
    { id: "t-none", code: "NON", first: null },
  ];

  const players = [];
  for (const team of teams) {
    for (const role of ROLES) {
      // Preise so gesetzt, dass ein Kader aus lauter Teuren nicht passt.
      const price = team.id === "t-late" ? 12 : team.id === "t-soon" ? 6 : 4;
      players.push({
        id: `${team.id}-${role}`, name: `${team.code}-${role}`, role,
        teamId: team.id, team: team.code + " Esports", code: team.code, league: "LEC",
        image: "", seasonPts: 100, seasonGames: 10, seasonAvg: 10,
        // Woher die Punkte kommen. Absichtlich je Rolle verschieden, damit
        // sich pruefen laesst, dass der Markt nicht ueberall dasselbe zeigt:
        // der Support lebt von Assists, der Bot von Kills.
        seasonK: role === "bottom" ? 60 : role === "support" ? 5 : 30,
        seasonA: role === "support" ? 90 : 40,
        seasonD: 20, seasonCs: role === "support" ? 400 : 2500, seasonWins: 6,
      });
    }
  }

  heading("Statistik einspielen");
  let res = await ingest("players", players, { first: true });
  check("Spieler werden angenommen", res.status === 200, res);
  res = await fetch(BASE + "/api/ingest", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer falsch" },
    body: JSON.stringify({ part: "players", rows: [] }),
  });
  check("Falsches Token wird abgewiesen", res.status === 401, res.status);

  const prevRound = "2000-W01"; // sicher vor der laufenden Runde
  await ingest("rounds", [
    { key: round.key, start: round.start, end: round.end },
    { key: prevRound, start: 946728000, end: 947332800 },
  ]);
  await ingest("prices", players.map(p => ({
    roundKey: round.key, playerId: p.id,
    price: p.id.startsWith("t-late") ? 12 : p.id.startsWith("t-soon") ? 6 : 4,
  })));
  // Punkte: jeder Spieler von t-soon bringt 10, von t-late 20, Rest 1.
  await ingest("playerRound", players.map(p => ({
    roundKey: round.key, playerId: p.id,
    pts: p.id.startsWith("t-late") ? 20 : p.id.startsWith("t-soon") ? 10 : 1,
    games: 2,
  })));
  await ingest("fixtures", teams.filter(t => t.first).map(t => ({
    roundKey: round.key, teamId: t.id, firstStart: t.first, opponent: "GEG",
    opponentId: "t-geg",
  })), { replaceRounds: [round.key] });
  // Zwei Spielzeilen mit Absicht: die erste geht mit der Formel unten genau
  // auf, die zweite nicht. So laesst sich beides pruefen - der Rechenweg und
  // der Hinweis, dass eine aeltere Zeile nach alter Formel gewertet bleibt.
  //   g1: 5*2 + 7*1.5 + 1*(-0.5) + 300*0.02 + 3 = 29.0
  await ingest("lines", [{
    gameId: "g1", playerId: "t-soon-mid", roundKey: round.key, matchId: "m1",
    league: "LEC", champion: "Jax", k: 5, d: 1, a: 7, cs: 300, pts: 29, winBonus: true,
    startedAt: now - 100,
  }, {
    gameId: "g2", playerId: "t-soon-mid", roundKey: round.key, matchId: "m1",
    league: "LEC", champion: "Sett", k: 2, d: 0, a: 3, cs: 250, pts: 7, winBonus: false,
    startedAt: now - 50,
  }]);
  res = await ingest("done", [], {
    scoring: { kill: 2, assist: 1.5, death: -0.5, cs: 0.02,
      bigGame: 2, bigGameAt: 10, deathless: 2, seriesWin: 3 },
  });
  check("Abschlussmeldung wird angenommen", res.status === 200, res);

  // ------------------------------------------------------------ Konten
  heading("Konten");
  const a = new Client("A");
  const b = new Client("B");
  const nameA = "Domi_" + uniq;
  const nameB = "Lisa_" + uniq;

  res = await a.post("/api/register", { name: nameA, password: "geheim12345" });
  check("Registrierung legt Konto an", res.status === 201 && res.data.user.name === nameA, res.data);
  check("Sitzungscookie ist HttpOnly", /HttpOnly/i.test(res.headers.get("set-cookie") || ""),
    res.headers.get("set-cookie"));

  res = await new Client("x").post("/api/register", { name: nameA, password: "geheim12345" });
  check("Doppelter Name wird abgelehnt", res.status === 409, res);

  res = await new Client("x").post("/api/register", { name: "Kurz_" + uniq, password: "kurz" });
  check("Zu kurzes Passwort wird abgelehnt", res.status === 400, res);

  res = await new Client("x").post("/api/register", { name: "!!", password: "geheim12345" });
  check("Unsinniger Name wird abgelehnt", res.status === 400, res);

  await b.post("/api/register", { name: nameB, password: "geheim12345" });

  const wrong = new Client("w");
  res = await wrong.post("/api/login", { name: nameA, password: "falschfalsch" });
  check("Falsches Passwort meldet 401", res.status === 401, res);
  check("Fehlgeschlagener Login setzt kein Cookie", wrong.cookie === null, wrong.cookie);

  res = await a.get("/api/me");
  check("Angemeldet erkannt", res.data.user && res.data.user.name === nameA, res.data);

  res = await new Client("anon").get("/api/leagues");
  check("Ohne Anmeldung kein Zugriff", res.status === 401, res.status);

  // ------------------------------------------------------------ Ligen
  heading("Ligen");
  res = await a.post("/api/leagues", { name: "Testliga " + uniq });
  const league = res.data.league;
  check("Liga wird angelegt", res.status === 201 && league.id, res.data);
  check("Einladungscode hat 8 Zeichen", /^[A-Z2-9]{8}$/.test(league.inviteCode || ""), league);
  check("Ersteller ist Besitzer", league.owner === true && league.members === 1, league);

  res = await b.get("/api/leagues/" + league.id);
  check("Fremde sehen die Liga nicht", res.status === 404, res.status);

  res = await b.post("/api/leagues/join", { code: "XXXXXXXX" });
  check("Falscher Code wird abgelehnt", res.status === 404, res.status);

  res = await b.post("/api/leagues/join", { code: league.inviteCode });
  check("Beitritt per Code klappt", res.status === 200 && res.data.joined === true, res.data);

  res = await b.post("/api/leagues/join", { code: league.inviteCode });
  check("Zweiter Beitritt ist harmlos", res.status === 200 && res.data.joined === false, res.data);

  res = await b.get("/api/leagues/" + league.id);
  check("Mitglied sieht die Liga", res.status === 200 && res.data.members.length === 2, res.data);
  check("Nur der Besitzer sieht den Code", res.data.league.inviteCode === null, res.data.league);

  // ------------------------------------------------------------ Kader
  heading("Kader aufstellen");
  const squadUrl = `/api/leagues/${league.id}/squad`;

  res = await a.get(`/api/leagues/${league.id}/market`);
  check("Markt liefert Spieler mit Preisen",
    res.status === 200 && res.data.players.length === 20 && res.data.players.every(p => p.price > 0),
    res.data.players && res.data.players.slice(0, 2));
  const soonMid0 = res.data.players.find(p => p.id === "t-soon-mid");
  check("Markt nennt den Anpfiff des Teams", soonMid0.kickoff > now, res.data.players[0]);
  // Eine Uhrzeit allein sagt wenig - gegen wen gespielt wird, gehoert dazu.
  check("Markt nennt auch den Gegner", soonMid0.opponent === "GEG", soonMid0);
  // Wodurch die Punkte zustande kommen. Ohne das steht im Markt nur, *dass*
  // jemand gut ist.
  check("Markt liefert die Herkunft der Punkte mit",
    soonMid0.kda && soonMid0.kda.k === 30 && soonMid0.kda.a === 40
    && soonMid0.kda.cs === 2500 && soonMid0.kda.wins === 6, soonMid0.kda);
  const soonSup = res.data.players.find(p => p.id === "t-soon-support");
  check("Und sie unterscheidet sich je Spieler",
    soonSup.kda.a === 90 && soonSup.kda.k === 5, soonSup.kda);

  res = await a.put(squadUrl, { role: "mid", playerId: "t-lock-mid" });
  check("Gesperrter Spieler wird abgelehnt", res.status === 409, res.data);

  res = await a.put(squadUrl, { role: "mid", playerId: "t-soon-top" });
  check("Falsche Position wird abgelehnt", res.status === 400, res.data);

  res = await a.put(squadUrl, { role: "mid", playerId: "gibtesnicht" });
  check("Unbekannter Spieler wird abgelehnt", res.status === 404, res.data);

  res = await a.put(squadUrl, { role: "mid", playerId: "t-late-mid" });
  check("Gueltiger Spieler wird gesetzt",
    res.status === 200 && res.data.me.slots.mid.playerId === "t-late-mid", res.data.me);
  check("Bezahlter Preis wird festgehalten", res.data.me.slots.mid.paid === 12, res.data.me.slots.mid);
  check("Kosten stimmen", res.data.me.cost === 12, res.data.me.cost);

  // 12 (mid) + 12 (top) + 12 = 36 > 35
  await a.put(squadUrl, { role: "top", playerId: "t-late-top" });
  res = await a.put(squadUrl, { role: "jungle", playerId: "t-late-jungle" });
  check("Budgetgrenze wird durchgesetzt", res.status === 400 && /teuer/i.test(res.data.error), res.data);

  // Auf einen guenstigeren Toplaner tauschen macht wieder Luft.
  res = await a.put(squadUrl, { role: "top", playerId: "t-soon-top" });
  check("Platz laesst sich auf guenstiger tauschen",
    res.status === 200 && res.data.me.cost === 18, res.data.me);
  check("Neuer Preis wird bezahlt, nicht der alte",
    res.data.me.slots.top.paid === 6, res.data.me.slots.top);

  await a.put(squadUrl, { role: "jungle", playerId: "t-soon-jungle" });
  await a.put(squadUrl, { role: "bottom", playerId: "t-none-bottom" });
  res = await a.put(squadUrl, { role: "support", playerId: "t-none-support" });
  check("Kader ist vollstaendig", res.data.me.complete === true, res.data.me);
  check("Gesamtkosten stimmen", res.data.me.cost === 6 + 6 + 12 + 4 + 4, res.data.me.cost);

  res = await a.put(squadUrl, { role: "support", playerId: "t-none-support" });
  check("Denselben Spieler nochmal setzen ist harmlos",
    res.status === 200 && res.data.me.cost === 32, res.data.me.cost);

  res = await a.put(squadUrl, { role: "mid", playerId: null });
  check("Platz laesst sich leeren", res.status === 200 && res.data.me.slots.mid === null, res.data.me);
  res = await a.put(squadUrl, { role: "mid", playerId: "t-late-mid" });
  check("und wieder besetzen", res.status === 200 && res.data.me.cost === 32, res.data.me.cost);

  // ------------------------------------------------------------ Punkte
  heading("Punkte");
  // A: top t-soon(10) + jungle t-soon(10) + mid t-late(20) + bot t-none(1) + sup t-none(1) = 42
  res = await a.get(`/api/leagues/${league.id}`);
  check("Rundenpunkte werden gerechnet", res.data.me.total === 42, res.data.me);

  res = await a.put(squadUrl, { captain: "mid" });
  check("Kapitaen wird gesetzt", res.status === 200 && res.data.me.captain === "mid", res.data.me);
  check("Kapitaen zaehlt doppelt", res.data.me.total === 62, res.data.me.total);

  res = await a.put(squadUrl, { captain: "quatsch" });
  check("Unbekannte Kapitaensposition wird abgelehnt", res.status === 400, res.data);

  // ------------------------------------------------------------ Verdeckt
  heading("Fremde Kader bleiben verdeckt");
  res = await b.get(`/api/leagues/${league.id}`);
  const aRow = res.data.members.find(m => m.name === nameA);
  check("B sieht As Kader nicht", aRow.hidden === true && aRow.slots === null, aRow);
  check("B sieht aber As Punktestand", aRow.total === 62, aRow);

  res = await b.get(`/api/leagues/${league.id}/breakdown?user=${aRow.userId}`);
  check("Aufschluesselung bleibt gesperrt", res.status === 403, res.status);

  for (const role of ROLES) {
    await b.put(squadUrl, { role, playerId: `t-soon-${role}` });
  }
  res = await b.get(`/api/leagues/${league.id}`);
  const aRow2 = res.data.members.find(m => m.name === nameA);
  check("Nach eigenem Kader wird As Kader sichtbar",
    aRow2.hidden === false && aRow2.slots.mid.playerId === "t-late-mid", aRow2.slots);
  check("Bs eigener Kader zaehlt 50", res.data.me.total === 50, res.data.me.total);
  check("Bs Kader kostet 30", res.data.me.cost === 30, res.data.me.cost);

  res = await b.get(`/api/leagues/${league.id}/breakdown?user=${aRow.userId}`);
  check("Aufschluesselung jetzt erlaubt", res.status === 200, res.status);

  // "Wie viele haben den?" ist die interessanteste Spalte des Marktes - sie
  // muss die echten Kader zaehlen, nicht nur den eigenen.
  res = await b.get(`/api/leagues/${league.id}/market`);
  check("Markt nennt die Mitgliederzahl", res.data.members === 2, res.data.members);
  const soonMid = res.data.players.find(p => p.id === "t-soon-mid");
  const lateMid = res.data.players.find(p => p.id === "t-late-mid");
  const noneMid = res.data.players.find(p => p.id === "t-none-mid");
  check("Von zwei Mitgliedern hat einer t-soon-mid", soonMid.picked === 1, soonMid.picked);
  check("Und einer t-late-mid", lateMid.picked === 1, lateMid.picked);
  check("Ungewaehlte stehen auf 0", noneMid.picked === 0, noneMid.picked);

  res = await b.get(`/api/leagues/${league.id}/breakdown`);
  check("Eigene Aufschluesselung zeigt beide Spielzeilen",
    res.data.lines.length === 2 && res.data.lines[0].winBonus === true, res.data.lines);
  // Ohne die Formel kann die Oberflaeche keinen Rechenweg zeigen - sie muss
  // deshalb mit der Ligaansicht mitkommen, nicht nur mit dem Markt.
  res = await b.get(`/api/leagues/${league.id}`);
  check("Ligaansicht liefert die Punkteformel mit",
    res.data.scoring && res.data.scoring.kill === 2 && res.data.scoring.seriesWin === 3,
    res.data.scoring);

  // ------------------------------------------------------------ Sperren
  heading("Sperren");
  res = await a.put(squadUrl, { role: "top", playerId: "t-lock-top" });
  check("Gesperrten Spieler holen geht nicht", res.status === 409, res.data);

  // ------------------------------------------------------------ Weiterlaufen
  heading("Kader laeuft in die naechste Runde weiter");
  // Eine spaetere Runde abfragen: dort gibt es keinen eigenen Eintrag, also
  // muss der Kader der laufenden Runde geerbt werden.
  res = await a.get(`/api/leagues/${league.id}?round=2030-W01`);
  check("Spaetere Runde erbt den Kader",
    res.status === 200 && res.data.me.slots.mid.playerId === "t-late-mid", res.data.me);
  check("Erbe ist als solches gekennzeichnet", res.data.me.inherited === true, res.data.me);
  check("Kapitaen laeuft mit", res.data.me.captain === "mid", res.data.me.captain);
  check("Ohne Ergebnisse gibt es dort 0 Punkte", res.data.me.total === 0, res.data.me.total);
  check("Kosten bleiben die bezahlten", res.data.me.cost === 32, res.data.me.cost);

  res = await a.get(`/api/leagues/${league.id}?round=2000-W01`);
  check("Vor dem ersten Kader ist nichts da",
    res.status === 200 && res.data.me.slots.mid === null, res.data.me);

  res = await a.get(`/api/leagues/${league.id}?round=quatsch`);
  check("Unsinnige Runde wird abgelehnt", res.status === 400, res.status);

  // ------------------------------------------------------------ Tabelle
  heading("Tabelle");
  res = await a.get(`/api/leagues/${league.id}/standings`);
  check("Tabelle listet beide", res.data.table.length === 2, res.data.table);
  check("Fuehrender steht oben", res.data.table[0].total >= res.data.table[1].total, res.data.table);
  check("Punkte der laufenden Runde zaehlen", res.data.table[0].total === 62, res.data.table[0]);

  return { leagueId: league.id, roundKey: round.key, userA: (await a.get("/api/me")).data.user.id, clientA: a };
}

const result = await main();
console.log(fails ? `\n${fails} FEHLER` : "\nALLE API-TESTS BESTANDEN");
export { result };
process.exit(fails ? 1 : 0);

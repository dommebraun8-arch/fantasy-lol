/**
 * Der eigentliche Spielbetrieb: Ligen, Kader, Punkte.
 *
 * Alles, was über Punkte oder Gültigkeit entscheidet, passiert hier und nicht
 * im Browser. Der Client schickt "setze Mid auf Spieler X" - Preis, Budget,
 * Sperre und Wertung bestimmt der Server. Sonst könnte jeder mit der
 * Entwicklerkonsole seinen Kader nachträglich umbauen.
 *
 * Zwei Regeln, die den Code prägen:
 *
 *  - **Ein Kader läuft weiter, bis man ihn ändert.** Gespeichert wird pro
 *    Runde. Fehlt für eine Runde ein Eintrag, gilt der letzte davor. Ändert
 *    jemand etwas, wird der geerbte Kader zuerst in die laufende Runde
 *    kopiert ("materialisiert") und dann geändert - sonst stünde dort nur ein
 *    einzelner Platz und der Rest wäre weg.
 *
 *  - **Gesperrt wird pro Platz.** Sobald das Team eines Spielers sein erstes
 *    Spiel der Runde begonnen hat, ist dieser Platz fest. Die übrigen bleiben
 *    offen. Das belohnt Planung, statt alles auf den Rundenstart zu legen.
 */

import { ROLES, fail, inviteCode, json, newId, nowSec, round1, roundFor } from "./util.js";

const MAX_LEAGUES_PER_USER = 20;
const DEFAULT_PRICE = 5.0;

// ---------------------------------------------------------------- Lesehelfer

async function priceTable(env, roundKey) {
  let rows = await env.DB.prepare("SELECT player_id, price FROM prices WHERE round_key = ?")
    .bind(roundKey).all();
  if (!rows.results.length) {
    // Der Sammler war seit dem Rundenwechsel noch nicht dran: dann gilt die
    // zuletzt bekannte Liste weiter, statt alles auf den Einheitspreis zu
    // werfen.
    const last = await env.DB.prepare("SELECT MAX(round_key) AS k FROM prices").first();
    if (last && last.k) {
      rows = await env.DB.prepare("SELECT player_id, price FROM prices WHERE round_key = ?")
        .bind(last.k).all();
    }
  }
  const map = new Map();
  for (const r of rows.results) map.set(r.player_id, r.price);
  return map;
}

async function fixtureTable(env, roundKey) {
  const rows = await env.DB.prepare(
    "SELECT team_id, first_start FROM fixtures WHERE round_key = ?"
  ).bind(roundKey).all();
  const map = new Map();
  for (const r of rows.results) map.set(r.team_id, r.first_start);
  return map;
}

/**
 * Die Punkteformel, wie der Sammler sie zuletzt gemeldet hat.
 *
 * Die App liefert sie mit aus, damit die Oberfläche den Rechenweg zeigen kann
 * ("4 Kills × 2 = 8") statt nur das Ergebnis. Zweitens hält sie die Anzeige
 * automatisch richtig, wenn die Punkte im Sammler mal geändert werden - eine
 * fest einprogrammierte Formel im Frontend würde dann still danebenliegen.
 */
async function scoringRules(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'scoring'").first();
  if (!row || !row.value) return null;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return null;
  }
}

/** Kader aller Mitglieder einer Runde, inklusive Erbe. */
async function allSquads(env, leagueId, roundKey) {
  const members = await env.DB.prepare(
    "SELECT user_id FROM members WHERE league_id = ?"
  ).bind(leagueId).all();
  const out = new Map();
  for (const m of members.results) {
    out.set(m.user_id, await effectiveSquad(env, leagueId, m.user_id, roundKey));
  }
  return out;
}

async function playerMap(env, ids) {
  if (!ids.length) return new Map();
  const marks = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, name, role, team_id, team, code, league, image, active
       FROM players WHERE id IN (${marks})`
  ).bind(...ids).all();
  const map = new Map();
  for (const r of rows.results) map.set(r.id, r);
  return map;
}

/**
 * Kader eines Mitglieds für eine Runde - inklusive Erbe aus früheren Runden.
 * Gibt { fromRound, slots: {role: {playerId, paid}}, captain } zurück.
 */
async function effectiveSquad(env, leagueId, userId, roundKey) {
  const row = await env.DB.prepare(
    `SELECT MAX(round_key) AS k FROM squads
      WHERE league_id = ? AND user_id = ? AND round_key <= ?`
  ).bind(leagueId, userId, roundKey).first();
  const from = row && row.k ? row.k : null;
  if (!from) return { fromRound: null, slots: {}, captain: null };

  const rows = await env.DB.prepare(
    "SELECT role, player_id, paid FROM squads WHERE league_id = ? AND user_id = ? AND round_key = ?"
  ).bind(leagueId, userId, from).all();
  const slots = {};
  for (const r of rows.results) slots[r.role] = { playerId: r.player_id, paid: r.paid };

  const meta = await env.DB.prepare(
    "SELECT captain FROM squad_meta WHERE league_id = ? AND user_id = ? AND round_key = ?"
  ).bind(leagueId, userId, from).first();

  return { fromRound: from, slots, captain: meta ? meta.captain : null };
}

function squadCost(slots) {
  return round1(ROLES.reduce((sum, role) => sum + (slots[role] ? slots[role].paid : 0), 0));
}

function squadComplete(slots) {
  return ROLES.every(role => slots[role]);
}

// ---------------------------------------------------------------- Mitgliedschaft

async function requireMember(env, leagueId, userId) {
  const league = await env.DB.prepare(
    "SELECT id, name, owner_id, invite_code, budget, created_at FROM leagues WHERE id = ?"
  ).bind(leagueId).first();
  if (!league) return { error: fail(404, "Liga nicht gefunden") };

  const member = await env.DB.prepare(
    "SELECT joined_at FROM members WHERE league_id = ? AND user_id = ?"
  ).bind(leagueId, userId).first();
  // Bewusst dieselbe Antwort wie bei einer unbekannten Liga: sonst ließe sich
  // durch Durchprobieren herausfinden, welche Ligen es gibt.
  if (!member) return { error: fail(404, "Liga nicht gefunden") };

  return { league, joinedAt: member.joined_at };
}

// ---------------------------------------------------------------- Endpunkte

export async function listMyLeagues(env, user) {
  const rows = await env.DB.prepare(
    `SELECT l.id, l.name, l.invite_code, l.budget, l.owner_id,
            (SELECT COUNT(*) FROM members m2 WHERE m2.league_id = l.id) AS members
       FROM leagues l
       JOIN members m ON m.league_id = l.id
      WHERE m.user_id = ?
      ORDER BY l.created_at`
  ).bind(user.id).all();
  return rows.results.map(r => ({
    id: r.id, name: r.name, inviteCode: r.invite_code, budget: r.budget,
    members: r.members, owner: r.owner_id === user.id,
  }));
}

export async function handleCreateLeague(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültige Anfrage");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 40) return fail(400, "Ligename: 2 bis 40 Zeichen");

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = ?")
    .bind(user.id).first();
  if (count && count.n >= MAX_LEAGUES_PER_USER) {
    return fail(400, "Du bist schon in genug Ligen");
  }

  const id = newId(10);
  const now = nowSec();
  // Bei einer Kollision des Codes einfach neu würfeln - passiert praktisch nie.
  let code = null;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = inviteCode();
    const taken = await env.DB.prepare("SELECT id FROM leagues WHERE invite_code = ?")
      .bind(candidate).first();
    if (!taken) code = candidate;
  }
  if (!code) return fail(500, "Kein freier Einladungscode gefunden");

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO leagues (id, name, owner_id, invite_code, budget, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, name, user.id, code, 35.0, now),
    env.DB.prepare("INSERT INTO members (league_id, user_id, joined_at) VALUES (?, ?, ?)")
      .bind(id, user.id, now),
  ]);

  return json({ league: { id, name, inviteCode: code, budget: 35.0, members: 1, owner: true } }, 201);
}

export async function handleJoinLeague(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültige Anfrage");
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!/^[A-Z2-9]{8}$/.test(code)) return fail(400, "Der Code besteht aus 8 Zeichen");

  const league = await env.DB.prepare(
    "SELECT id, name, budget FROM leagues WHERE invite_code = ?"
  ).bind(code).first();
  if (!league) return fail(404, "Diesen Einladungscode gibt es nicht");

  const already = await env.DB.prepare(
    "SELECT user_id FROM members WHERE league_id = ? AND user_id = ?"
  ).bind(league.id, user.id).first();
  if (!already) {
    await env.DB.prepare("INSERT INTO members (league_id, user_id, joined_at) VALUES (?, ?, ?)")
      .bind(league.id, user.id, nowSec()).run();
  }
  return json({ league: { id: league.id, name: league.name }, joined: !already });
}

/**
 * Alles, was der Ligabildschirm braucht: Mitglieder, eigener Kader mit
 * Sperren, Punkte der laufenden Runde, Tabelle.
 */
export async function handleLeagueView(env, user, leagueId, wantRound) {
  const check = await requireMember(env, leagueId, user.id);
  if (check.error) return check.error;
  const { league } = check;

  const now = nowSec();
  const current = roundFor(Date.now());
  const roundKey = wantRound || current.key;

  const roundRow = await env.DB.prepare(
    "SELECT round_key, start_at, end_at FROM rounds WHERE round_key = ?"
  ).bind(roundKey).first();
  const round = roundRow
    ? { key: roundRow.round_key, start: roundRow.start_at, end: roundRow.end_at }
    : (roundKey === current.key ? current : { key: roundKey, start: null, end: null });
  const roundOver = round.end !== null && now >= round.end;

  const members = await env.DB.prepare(
    `SELECT u.id, u.name, m.joined_at
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.league_id = ? ORDER BY m.joined_at`
  ).bind(leagueId).all();

  const [prices, fixtures] = await Promise.all([priceTable(env, roundKey), fixtureTable(env, roundKey)]);

  const perRound = await env.DB.prepare(
    "SELECT player_id, pts, games FROM player_round WHERE round_key = ?"
  ).bind(roundKey).all();
  const roundPts = new Map();
  for (const r of perRound.results) roundPts.set(r.player_id, { pts: r.pts, games: r.games });

  const squads = await allSquads(env, leagueId, roundKey);

  const ids = new Set();
  for (const sq of squads.values()) {
    for (const role of ROLES) if (sq.slots[role]) ids.add(sq.slots[role].playerId);
  }
  const players = await playerMap(env, [...ids]);

  const mine = squads.get(user.id) || { slots: {}, captain: null, fromRound: null };
  const reveal = roundOver || squadComplete(mine.slots);

  const describe = (sq, withSquad) => {
    let total = 0;
    const slots = {};
    for (const role of ROLES) {
      const slot = sq.slots[role];
      if (!slot) { slots[role] = null; continue; }
      const stat = roundPts.get(slot.playerId) || { pts: 0, games: 0 };
      const mult = sq.captain === role ? 2 : 1;
      total += stat.pts * mult;
      if (!withSquad) continue;
      const p = players.get(slot.playerId) || null;
      const kickoff = p && p.team_id ? (fixtures.get(p.team_id) ?? null) : null;
      slots[role] = {
        playerId: slot.playerId,
        name: p ? p.name : "Unbekannt",
        team: p ? p.team : "", code: p ? p.code : "", league: p ? p.league : "",
        image: p ? p.image : "",
        paid: slot.paid,
        price: prices.get(slot.playerId) ?? null,
        pts: round1(stat.pts), games: stat.games,
        captain: sq.captain === role,
        kickoff,
        locked: kickoff !== null && kickoff <= now,
      };
    }
    return {
      total: round1(total),
      cost: squadCost(sq.slots),
      complete: squadComplete(sq.slots),
      captain: withSquad ? sq.captain : null,
      inherited: sq.fromRound !== null && sq.fromRound !== roundKey,
      slots: withSquad ? slots : null,
    };
  };

  const table = members.results.map(m => {
    const sq = squads.get(m.id);
    const own = m.id === user.id;
    // Fremde Kader bleiben verdeckt, bis der eigene steht - sonst schreibt man
    // einfach ab. Die Punktzahl ist trotzdem sichtbar, die verrät keine
    // Aufstellung und macht den Wettkampf erst spannend.
    const view = describe(sq, own || reveal);
    return { userId: m.id, name: m.name, you: own, hidden: !(own || reveal), ...view };
  });

  return json({
    scoring: await scoringRules(env),
    league: {
      id: league.id, name: league.name, budget: league.budget,
      inviteCode: league.owner_id === user.id ? league.invite_code : null,
      owner: league.owner_id === user.id,
    },
    round: { ...round, current: roundKey === current.key, over: roundOver },
    reveal,
    members: table,
    me: table.find(t => t.you) || null,
  });
}

/** Punkte-Aufschlüsselung eines Mitglieds: welche Spiele haben was gebracht. */
export async function handleBreakdown(env, user, leagueId, roundKey, targetId) {
  const check = await requireMember(env, leagueId, user.id);
  if (check.error) return check.error;

  const target = targetId || user.id;
  const isMember = await env.DB.prepare(
    "SELECT user_id FROM members WHERE league_id = ? AND user_id = ?"
  ).bind(leagueId, target).first();
  if (!isMember) return fail(404, "Kein Mitglied dieser Liga");

  const now = nowSec();
  const roundRow = await env.DB.prepare("SELECT end_at FROM rounds WHERE round_key = ?")
    .bind(roundKey).first();
  const roundOver = roundRow ? now >= roundRow.end_at : false;

  if (target !== user.id) {
    const mine = await effectiveSquad(env, leagueId, user.id, roundKey);
    if (!roundOver && !squadComplete(mine.slots)) {
      return fail(403, "Erst den eigenen Kader vervollständigen");
    }
  }

  const sq = await effectiveSquad(env, leagueId, target, roundKey);
  const ids = ROLES.map(r => sq.slots[r] && sq.slots[r].playerId).filter(Boolean);
  if (!ids.length) return json({ roundKey, lines: [] });

  const marks = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT player_id, champion, k, d, a, cs, pts, win_bonus, started_at, league
       FROM lines WHERE round_key = ? AND player_id IN (${marks})
      ORDER BY started_at, game_id`
  ).bind(roundKey, ...ids).all();

  return json({
    roundKey,
    captain: sq.captain,
    lines: rows.results.map(r => ({
      playerId: r.player_id, champion: r.champion,
      k: r.k, d: r.d, a: r.a, cs: r.cs,
      pts: r.pts, winBonus: !!r.win_bonus,
      startedAt: r.started_at, league: r.league,
    })),
  });
}

/** Gesamttabelle über alle Runden, in denen jemand Mitglied war. */
export async function handleStandings(env, user, leagueId) {
  const check = await requireMember(env, leagueId, user.id);
  if (check.error) return check.error;

  const members = await env.DB.prepare(
    `SELECT u.id, u.name, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.league_id = ? ORDER BY m.joined_at`
  ).bind(leagueId).all();

  const roundRows = await env.DB.prepare(
    "SELECT round_key, start_at, end_at FROM rounds ORDER BY round_key"
  ).all();

  const squadRows = await env.DB.prepare(
    "SELECT user_id, round_key, role, player_id FROM squads WHERE league_id = ? ORDER BY round_key"
  ).bind(leagueId).all();
  const capRows = await env.DB.prepare(
    "SELECT user_id, round_key, captain FROM squad_meta WHERE league_id = ?"
  ).bind(leagueId).all();

  const ptsRows = await env.DB.prepare(
    `SELECT round_key, player_id, pts FROM player_round
      WHERE player_id IN (SELECT DISTINCT player_id FROM squads WHERE league_id = ?)`
  ).bind(leagueId).all();
  const ptsBy = new Map();
  for (const r of ptsRows.results) ptsBy.set(r.round_key + "|" + r.player_id, r.pts);

  // Kader je Nutzer und Runde sortiert, damit das Erben in einem Durchlauf geht.
  const byUser = new Map();
  for (const r of squadRows.results) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map());
    const rounds = byUser.get(r.user_id);
    if (!rounds.has(r.round_key)) rounds.set(r.round_key, { slots: {}, captain: null });
    rounds.get(r.round_key).slots[r.role] = r.player_id;
  }
  for (const r of capRows.results) {
    const rounds = byUser.get(r.user_id);
    if (rounds && rounds.has(r.round_key)) rounds.get(r.round_key).captain = r.captain;
  }

  const table = members.results.map(m => {
    const rounds = byUser.get(m.id) || new Map();
    const keys = [...rounds.keys()].sort();
    let total = 0;
    const history = [];
    for (const r of roundRows.results) {
      if (r.end_at <= m.joined_at) continue; // vor dem Beitritt zählt nichts
      let use = null;
      for (const k of keys) {
        if (k <= r.round_key) use = k; else break;
      }
      if (!use) continue;
      const squad = rounds.get(use);
      let sum = 0;
      for (const role of ROLES) {
        const pid = squad.slots[role];
        if (!pid) continue;
        const pts = ptsBy.get(r.round_key + "|" + pid) || 0;
        sum += pts * (squad.captain === role ? 2 : 1);
      }
      total += sum;
      history.push({ roundKey: r.round_key, pts: round1(sum) });
    }
    return { userId: m.id, name: m.name, you: m.id === user.id, total: round1(total), history };
  });

  table.sort((a, b) => b.total - a.total);
  return json({ table });
}

/** Spielermarkt: alle wählbaren Spieler mit Preis, Schnitt und Anpfiff. */
export async function handleMarket(env, user, leagueId) {
  const check = await requireMember(env, leagueId, user.id);
  if (check.error) return check.error;

  const current = roundFor(Date.now());
  const [prices, fixtures] = await Promise.all([
    priceTable(env, current.key), fixtureTable(env, current.key),
  ]);

  // Wie viele Mitglieder haben den Spieler im Kader? Im Vorbild aus dem
  // Fussball heisst das "ausgewaehlt" und ist die interessanteste Spalte:
  // sie zeigt, wo alle hinlaufen und wo noch etwas zu holen ist.
  const squads = await allSquads(env, leagueId, current.key);
  const picked = new Map();
  for (const squad of squads.values()) {
    for (const role of ROLES) {
      const slot = squad.slots[role];
      if (slot) picked.set(slot.playerId, (picked.get(slot.playerId) || 0) + 1);
    }
  }
  const memberCount = squads.size || 1;

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.role, p.team_id, p.team, p.code, p.league, p.image,
            p.season_pts, p.season_games, p.season_avg,
            COALESCE(pr.pts, 0) AS round_pts
       FROM players p
       LEFT JOIN player_round pr ON pr.player_id = p.id AND pr.round_key = ?
      WHERE p.active = 1
      ORDER BY p.season_avg DESC`
  ).bind(current.key).all();

  return json({
    round: current,
    members: memberCount,
    scoring: await scoringRules(env),
    players: rows.results.map(r => ({
      id: r.id, name: r.name, role: r.role, team: r.team, code: r.code,
      league: r.league, image: r.image,
      price: prices.get(r.id) ?? DEFAULT_PRICE,
      avg: r.season_avg, games: r.season_games, season: r.season_pts,
      roundPts: round1(r.round_pts),
      kickoff: r.team_id ? (fixtures.get(r.team_id) ?? null) : null,
      picked: picked.get(r.id) || 0,
    })),
  });
}

/**
 * Kader ändern. Nimmt entweder { role, playerId } oder { captain }.
 * Preis, Budget und Sperre prüft der Server.
 */
export async function handleSetSquad(request, env, user, leagueId) {
  const check = await requireMember(env, leagueId, user.id);
  if (check.error) return check.error;
  const { league } = check;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültige Anfrage");
  }

  const current = roundFor(Date.now());
  const now = nowSec();
  const [prices, fixtures] = await Promise.all([
    priceTable(env, current.key), fixtureTable(env, current.key),
  ]);

  const squad = await effectiveSquad(env, leagueId, user.id, current.key);
  const slots = { ...squad.slots };
  let captain = squad.captain;

  const lockedFor = async pid => {
    if (!pid) return false;
    const p = await env.DB.prepare("SELECT team_id FROM players WHERE id = ?").bind(pid).first();
    if (!p || !p.team_id) return false;
    const start = fixtures.get(p.team_id);
    return start !== undefined && start <= now;
  };

  if (typeof body.role === "string") {
    const role = body.role;
    if (!ROLES.includes(role)) return fail(400, "Unbekannte Position");

    const playerId = body.playerId === null || body.playerId === "" ? null : body.playerId;

    if (slots[role] && await lockedFor(slots[role].playerId)) {
      return fail(409, "Dieser Platz ist gesperrt - das Team hat diese Runde schon gespielt");
    }

    if (playerId === null) {
      delete slots[role];
      if (captain === role) captain = null;
    } else {
      if (typeof playerId !== "string" || playerId.length > 64) return fail(400, "Ungültiger Spieler");
      const player = await env.DB.prepare(
        "SELECT id, role, team_id, active FROM players WHERE id = ?"
      ).bind(playerId).first();
      if (!player) return fail(404, "Spieler nicht gefunden");
      if (player.role !== role) return fail(400, "Der Spieler spielt eine andere Position");
      if (!player.active) return fail(400, "Der Spieler steht in keinem aktiven Kader");
      if (await lockedFor(playerId)) {
        return fail(409, "Das Team dieses Spielers hat diese Runde schon gespielt");
      }
      for (const other of ROLES) {
        if (other !== role && slots[other] && slots[other].playerId === playerId) {
          return fail(400, "Der Spieler steht schon in deinem Kader");
        }
      }

      const price = prices.get(playerId) ?? DEFAULT_PRICE;
      const rest = ROLES.reduce(
        (sum, r) => sum + (r !== role && slots[r] ? slots[r].paid : 0), 0);
      if (round1(rest + price) > league.budget + 0.001) {
        return fail(400, `Zu teuer: ${round1(rest + price)} von ${league.budget} - `
          + "tausche zuerst auf einem anderen Platz jemanden Günstigeren ein");
      }
      slots[role] = { playerId, paid: price };
    }
  } else if (typeof body.captain !== "undefined") {
    const next = body.captain === null || body.captain === "" ? null : body.captain;
    if (next !== null && !ROLES.includes(next)) return fail(400, "Unbekannte Position");
    if (next !== null && !slots[next]) return fail(400, "Auf diesem Platz steht niemand");
    // Den Kapitän zu verschieben, nachdem er gespielt hat, wäre nachträgliches
    // Rosinenpicken - deshalb müssen beide Seiten noch offen sein.
    if (captain && slots[captain] && await lockedFor(slots[captain].playerId)) {
      return fail(409, "Der Kapitän hat schon gespielt und lässt sich nicht mehr wechseln");
    }
    if (next && await lockedFor(slots[next].playerId)) {
      return fail(409, "Dieser Spieler hat diese Runde schon gespielt");
    }
    captain = next;
  } else {
    return fail(400, "Nichts zu ändern");
  }

  // Geerbten Kader in die laufende Runde schreiben und dann die Änderung
  // festhalten - ein einzelner Platz allein würde den Rest verlieren.
  const statements = [
    env.DB.prepare("DELETE FROM squads WHERE league_id = ? AND user_id = ? AND round_key = ?")
      .bind(leagueId, user.id, current.key),
  ];
  for (const role of ROLES) {
    if (!slots[role]) continue;
    statements.push(env.DB.prepare(
      "INSERT INTO squads (league_id, user_id, round_key, role, player_id, paid) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(leagueId, user.id, current.key, role, slots[role].playerId, slots[role].paid));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO squad_meta (league_id, user_id, round_key, captain, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (league_id, user_id, round_key) DO UPDATE SET captain = excluded.captain, updated_at = excluded.updated_at`
  ).bind(leagueId, user.id, current.key, captain, now));

  await env.DB.batch(statements);

  return handleLeagueView(env, user, leagueId, current.key);
}

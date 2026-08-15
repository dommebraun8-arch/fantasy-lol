/**
 * Einspielen der Statistikdaten.
 *
 * Schreibt ausschließlich der Sammler (GitHub Action), ausgewiesen über
 * INGEST_TOKEN. Die Daten kommen stückweise ("part"), damit auch eine
 * Nachsaison mit tausenden Zeilen nicht an der Laufzeitgrenze eines Workers
 * scheitert: der Sammler schickt lieber zehn kleine Pakete als eines, das
 * mittendrin abbricht.
 *
 * Alle Teile sind wiederholbar (INSERT OR REPLACE bzw. gezieltes Löschen
 * vorab). Ein abgebrochener Lauf lässt sich also einfach nochmal schicken.
 */

import { fail, json, nowSec } from "./util.js";

const MAX_ROWS = 600;
const STATEMENTS_PER_BATCH = 20;
// D1 erlaubt höchstens 100 gebundene Werte je Anweisung - deutlich weniger als
// SQLite selbst. Wie viele Zeilen in eine Anweisung passen, hängt deshalb an
// der Spaltenzahl der Tabelle.
const MAX_BOUND_VALUES = 100;

function authorized(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env.INGEST_TOKEN || "";
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Viele Zeilen in wenigen Anweisungen - eine pro Zeile wäre viel zu langsam. */
async function bulk(env, table, columns, rows) {
  const perStatement = Math.max(1, Math.floor(MAX_BOUND_VALUES / columns.length));
  const statements = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const values = [];
    for (const row of chunk) for (const col of columns) values.push(row[col] ?? null);
    statements.push(env.DB.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`
    ).bind(...values));
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await env.DB.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
}

function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v, max = 200) {
  return typeof v === "string" ? v.slice(0, max) : null;
}

export async function handleIngest(request, env) {
  if (!authorized(request, env)) return fail(401, "Nicht berechtigt");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültiges JSON");
  }
  const part = body.part;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS) return fail(413, `Höchstens ${MAX_ROWS} Zeilen je Anfrage`);

  switch (part) {
    case "players": {
      // Beim ersten Paket alle auf inaktiv setzen; wer danach geliefert wird,
      // ist wieder aktiv. So verschwinden Spieler, die kein Team mehr haben,
      // aus der Auswahl - ohne ihre Punkte zu verlieren.
      if (body.first) await env.DB.prepare("UPDATE players SET active = 0").run();
      await bulk(env, "players",
        ["id", "name", "role", "team_id", "team", "code", "league", "image", "active",
          "season_pts", "season_games", "season_avg"],
        rows.map(r => ({
          id: str(r.id, 64), name: str(r.name, 80) || "?", role: str(r.role, 16) || "mid",
          team_id: str(r.teamId, 64), team: str(r.team, 80), code: str(r.code, 16),
          league: str(r.league, 32), image: str(r.image, 400), active: 1,
          season_pts: num(r.seasonPts), season_games: num(r.seasonGames),
          season_avg: num(r.seasonAvg),
        })).filter(r => r.id));
      break;
    }
    case "rounds": {
      await bulk(env, "rounds", ["round_key", "start_at", "end_at"],
        rows.map(r => ({ round_key: str(r.key, 16), start_at: num(r.start), end_at: num(r.end) }))
          .filter(r => r.round_key));
      break;
    }
    case "playerRound": {
      await bulk(env, "player_round", ["round_key", "player_id", "pts", "games"],
        rows.map(r => ({
          round_key: str(r.roundKey, 16), player_id: str(r.playerId, 64),
          pts: num(r.pts), games: num(r.games),
        })).filter(r => r.round_key && r.player_id));
      break;
    }
    case "prices": {
      await bulk(env, "prices", ["round_key", "player_id", "price"],
        rows.map(r => ({
          round_key: str(r.roundKey, 16), player_id: str(r.playerId, 64), price: num(r.price, 5),
        })).filter(r => r.round_key && r.player_id));
      break;
    }
    case "lines": {
      await bulk(env, "lines",
        ["game_id", "player_id", "round_key", "match_id", "league", "champion",
          "k", "d", "a", "cs", "pts", "win_bonus", "started_at"],
        rows.map(r => ({
          game_id: str(r.gameId, 64), player_id: str(r.playerId, 64),
          round_key: str(r.roundKey, 16), match_id: str(r.matchId, 64),
          league: str(r.league, 32), champion: str(r.champion, 40),
          k: num(r.k), d: num(r.d), a: num(r.a), cs: num(r.cs), pts: num(r.pts),
          win_bonus: r.winBonus ? 1 : 0, started_at: num(r.startedAt),
        })).filter(r => r.game_id && r.player_id));
      break;
    }
    case "fixtures": {
      // Spielpläne verschieben sich: die betroffenen Runden vorher leeren,
      // sonst bliebe ein abgesagter Anpfiff als Sperre stehen.
      const keys = Array.isArray(body.replaceRounds) ? body.replaceRounds.slice(0, 10) : [];
      for (const key of keys) {
        if (typeof key === "string") {
          await env.DB.prepare("DELETE FROM fixtures WHERE round_key = ?").bind(key).run();
        }
      }
      await bulk(env, "fixtures", ["round_key", "team_id", "first_start"],
        rows.map(r => ({
          round_key: str(r.roundKey, 16), team_id: str(r.teamId, 64), first_start: num(r.firstStart),
        })).filter(r => r.round_key && r.team_id));
      break;
    }
    case "done": {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_ingest', ?)"
      ).bind(String(nowSec())).run();
      if (body.scoring) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('scoring', ?)"
        ).bind(JSON.stringify(body.scoring).slice(0, 2000)).run();
      }
      break;
    }
    default:
      return fail(400, "Unbekannter Teil");
  }

  return json({ ok: true, part, rows: rows.length });
}

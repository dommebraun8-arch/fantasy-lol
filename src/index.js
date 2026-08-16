/**
 * Ein Worker für alles: API unter /api/*, darunter die statische App.
 *
 * Die Reihenfolge ist Absicht - erst der Code, dann die Dateien. Andersherum
 * könnte eine Datei namens "api" die Schnittstelle verschlucken, und beim
 * Wechsel der Asset-Router-Version wäre nicht mehr klar, wer gewinnt.
 */

import { currentUser, handleLogin, handleLogout, handleRegister } from "./auth.js";
import {
  handleBreakdown, handleCreateLeague, handleJoinLeague, handleLeagueView,
  handleMarket, handleSetSquad, handleStandings, listMyLeagues,
} from "./game.js";
import { handleIngest } from "./ingest.js";
import { BUILD, fail, isRoundKey, json, roundFor } from "./util.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  // Die App bringt keinen Fremdcode mit; nur Spielerbilder kommen von außen.
  "content-security-policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; "
    + "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function withSecurity(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method;

  if (path === "/api/ingest" && method === "POST") return handleIngest(request, env);

  if (path === "/api/register" && method === "POST") return handleRegister(request, env);
  if (path === "/api/login" && method === "POST") return handleLogin(request, env);
  if (path === "/api/logout" && method === "POST") return handleLogout(request, env);

  const user = await currentUser(request, env);
  if (path === "/api/me") {
    if (method !== "GET") return fail(405, "Methode nicht erlaubt");
    // build steht auch ohne Anmeldung drin: damit laesst sich von aussen
    // pruefen, welche Fassung ausgeliefert wird.
    if (!user) return json({ user: null, build: BUILD, round: roundFor(Date.now()) });
    return json({
      user, build: BUILD,
      leagues: await listMyLeagues(env, user), round: roundFor(Date.now()),
    });
  }

  if (!user) return fail(401, "Nicht angemeldet");

  if (path === "/api/leagues") {
    if (method === "GET") return json({ leagues: await listMyLeagues(env, user) });
    if (method === "POST") return handleCreateLeague(request, env, user);
    return fail(405, "Methode nicht erlaubt");
  }
  if (path === "/api/leagues/join" && method === "POST") return handleJoinLeague(request, env, user);

  const league = path.match(/^\/api\/leagues\/([A-Za-z0-9]{1,32})(\/[a-z]+)?$/);
  if (league) {
    const id = league[1];
    const sub = league[2] || "";
    const wantRound = url.searchParams.get("round");
    if (wantRound && !isRoundKey(wantRound)) return fail(400, "Ungültige Runde");

    if (sub === "" && method === "GET") return handleLeagueView(env, user, id, wantRound);
    if (sub === "/squad" && method === "PUT") return handleSetSquad(request, env, user, id);
    if (sub === "/market" && method === "GET") return handleMarket(env, user, id);
    if (sub === "/standings" && method === "GET") return handleStandings(env, user, id);
    if (sub === "/breakdown" && method === "GET") {
      const round = wantRound || roundFor(Date.now()).key;
      return handleBreakdown(env, user, id, round, url.searchParams.get("user"));
    }
    return fail(404, "Nicht gefunden");
  }

  return fail(404, "Nicht gefunden");
}

/**
 * Aus einem Serverfehler eine Meldung machen, mit der man etwas anfangen kann.
 *
 * "Da ist serverseitig etwas schiefgegangen" ist eine Sackgasse - man sieht
 * nicht, ob die Datenbank fehlt, das Schema veraltet ist oder wirklich ein
 * Fehler im Code steckt. Der haeufigste Fall in diesem Projekt ist der
 * mittlere: deployen ist ein Befehl, migrieren ein zweiter, und wer den
 * zweiten vergisst, steht vor genau dieser Meldung.
 *
 * Der Stacktrace bleibt im Log. Nach aussen geht nur die eine Zeile, die
 * sagt, was zu tun ist.
 */
export function serverErrorMessage(err) {
  const text = String((err && err.message) || err || "");
  if (/no such column|no such table|has no column named/i.test(text)) {
    return "Die Datenbank ist älter als der Code - es fehlt eine Migration. "
      + "Einmal \"npm run db:remote\" laufen lassen, dann geht es weiter.";
  }
  return "Da ist serverseitig etwas schiefgegangen";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return withSecurity(await api(request, env, url));
      } catch (err) {
        // Nie den Stacktrace ausliefern, aber im Log soll er stehen.
        console.error("API-Fehler", url.pathname, err && err.stack ? err.stack : err);
        return withSecurity(fail(500, serverErrorMessage(err)));
      }
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withSecurity(asset);

    // Unbekannter Pfad: die App laden, sie kennt ihre eigenen Ansichten.
    const index = new URL("/index.html", url.origin);
    const fallback = await env.ASSETS.fetch(new Request(index, { headers: request.headers }));
    return withSecurity(new Response(fallback.body, { status: fallback.status, headers: fallback.headers }));
  },
};

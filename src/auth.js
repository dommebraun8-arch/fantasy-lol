/**
 * Konten und Anmeldung.
 *
 * Passwörter: PBKDF2-HMAC-SHA256 mit 120.000 Runden und eigenem Salt je Konto.
 * Das ist das Beste, was die Web-Crypto-API eines Workers ohne Fremdcode
 * hergibt (bcrypt/argon2 gibt es dort nicht) und für eine Freundesrunde
 * deutlich mehr als ausreichend.
 *
 * Sitzungen: zufälliges Token in der Datenbank, im Browser nur als
 * HttpOnly-Cookie. Damit kann kein Skript im Browser das Token auslesen, und
 * ein Logout macht es serverseitig ungültig - anders als bei einem signierten
 * Token, das bis zum Ablauf gültig bliebe.
 */

import { fail, json, newId, nowSec } from "./util.js";

const PBKDF2_ROUNDS = 120000;
const COOKIE = "fl_session";
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    key, 256);
  return bytesToHex(new Uint8Array(bits));
}

/** Vergleich ohne Zeitunterschied, damit sich ein Hash nicht erraten lässt. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function nameKey(name) {
  return name.trim().toLowerCase();
}

function validName(name) {
  return typeof name === "string" && /^[\p{L}\p{N} _.-]{2,24}$/u.test(name.trim());
}

function cookieHeader(token, days, secure) {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${days * 86400}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader(secure) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return rest.join("=");
  }
  return null;
}

/** Über http (lokale Entwicklung) darf das Cookie nicht Secure sein. */
function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

function sessionDays(env) {
  const n = parseInt(env.SESSION_DAYS || "30", 10);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
}

async function startSession(env, userId, days) {
  const token = newId(32);
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, userId, now, now + days * 86400).run();
  return token;
}

/** Angemeldeter Nutzer oder null. Räumt abgelaufene Sitzungen nebenbei weg. */
export async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < nowSec()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  return { id: row.id, name: row.name };
}

export async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültige Anfrage");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!validName(name)) {
    return fail(400, "Name: 2 bis 24 Zeichen, Buchstaben, Zahlen, Leer- und Satzzeichen");
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return fail(400, `Passwort: mindestens ${MIN_PASSWORD} Zeichen`);
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE name_key = ?")
    .bind(nameKey(name)).first();
  if (existing) return fail(409, "Diesen Namen gibt es schon");

  const salt = newId(16);
  const hash = await derive(password, salt);
  const id = newId(12);
  await env.DB.prepare(
    "INSERT INTO users (id, name, name_key, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, name, nameKey(name), hash, salt, nowSec()).run();

  const days = sessionDays(env);
  const token = await startSession(env, id, days);
  return json({ user: { id, name } }, 201, {
    "set-cookie": cookieHeader(token, days, isSecure(request)),
  });
}

export async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "Ungültige Anfrage");
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const user = await env.DB.prepare(
    "SELECT id, name, pw_hash, pw_salt FROM users WHERE name_key = ?"
  ).bind(nameKey(name)).first();

  // Auch ohne Treffer einmal rechnen: sonst verrät die Antwortzeit, welche
  // Namen es gibt.
  const salt = user ? user.pw_salt : "00000000000000000000000000000000";
  const hash = await derive(password, salt);
  if (!user || !sameSecret(hash, user.pw_hash)) {
    return fail(401, "Name oder Passwort stimmt nicht");
  }

  const days = sessionDays(env);
  const token = await startSession(env, user.id, days);
  return json({ user: { id: user.id, name: user.name } }, 200, {
    "set-cookie": cookieHeader(token, days, isSecure(request)),
  });
}

export async function handleLogout(request, env) {
  const token = readCookie(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "set-cookie": clearCookieHeader(isSecure(request)) });
}

/* Fantasy LoL - Oberfläche
 *
 * Bewusst ohne Framework: die App hat vier Ansichten und einen Zustand, der
 * komplett vom Server kommt. Jede Änderung schickt eine Anfrage und zeichnet
 * mit der Antwort neu - es gibt keinen zweiten Rechenweg im Browser, der vom
 * Server abweichen könnte. Preise, Sperren, Budget und Punkte entscheidet
 * ausschließlich der Worker.
 *
 * Achtung bei Änderungen: strenge CSP (style-src 'self'). Keine style-Attribute
 * im Markup - dynamische Werte über CSS-Variablen und element.style.setProperty.
 */

const ROLES = [
  { key: "top", label: "Top" },
  { key: "jungle", label: "Jungle" },
  { key: "mid", label: "Mid" },
  { key: "bottom", label: "Bot" },
  { key: "support", label: "Support" },
];
const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.key, r.label]));

const state = {
  build: null,       // Fassung, die der Server ausliefert
  user: null,
  leagues: [],
  leagueId: null,
  league: null,      // Antwort von GET /api/leagues/:id
  market: null,
  standings: null,
  breakdown: null,
  tab: "squad",
  scoring: null,     // Punkteformel vom Server, fuer den Rechenweg
  authMode: "login",
  message: null,     // { kind: "err" | "ok" | "info", text }
  busy: false,
};

const app = document.getElementById("app");
const tabsEl = document.getElementById("tabs");
const whoEl = document.getElementById("who");
const railEl = document.getElementById("rail");
const meEl = document.getElementById("me");

// ---------------------------------------------------------------- Helfer

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(n) {
  return (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);
}

function whenShort(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("de-DE",
    { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function whenLong(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("de-DE",
    { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function roundLabel(key) {
  return key ? key.replace("-W", " · KW ") : "";
}

function avatar(p) {
  const initial = esc((p.name || "?").slice(0, 1).toUpperCase());
  // Ohne Bild ein Kreis mit Anfangsbuchstabe - kein kaputtes Bildsymbol.
  if (!p.image) return `<span class="avatar" data-initial="${initial}">${initial}</span>`;
  return `<img class="avatar" src="${esc(p.image)}" alt="" loading="lazy">`;
}

/** Das Rollenzeichen aus dem Sprite in index.html. */
function roleIcon(role, cls = "role-ico") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#ic-${esc(role)}"/></svg>`;
}

/**
 * Der Farbton einer Mannschaft, aus dem Kürzel gerechnet.
 *
 * Vereinsfarben liefert die API nicht, und eine Liste von Hand veraltet mit
 * jedem Kaderwechsel. Gerechnet bekommt jede Mannschaft automatisch eine
 * eigene Farbe, und dasselbe Kürzel ergibt immer dieselbe - darauf beruht der
 * eigentliche Nutzen: fünf Farben im Kader heißt fünf Vereine, zwei gleiche
 * heißt zwei Spieler, die am selben Tag gesperrt sind.
 *
 * Bewusst keine echten Vereinsfarben: die halbe LEC spielt in Rot, damit wäre
 * die Unterscheidbarkeit dahin - und genau die ist hier der Zweck.
 */
function teamHue(code) {
  const text = String(code || "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  // Gelbgrün um 60-80 herum kollidiert mit dem goldenen Akzent der App.
  return hash >= 55 && hash <= 85 ? (hash + 40) % 360 : hash;
}

/** Wappen der Liga, wenn der Sammler eines mitgeschickt hat. */
function leagueCrest(league) {
  const src = (state.leagueCrests || {})[league];
  if (src) return `<span class="leaguemark"><img src="${esc(src)}" alt="${esc(league)}" loading="lazy"></span>`;
  if (!league) return '<span class="leaguemark"></span>';
  return `<span class="leaguemark"><span class="fb">${esc(league)}</span></span>`;
}

/** Vereinswappen, sonst das Kürzel im selben Rahmen. */
function teamCrest(p) {
  const code = esc(p.code || p.team || "?");
  if (p.teamImage) {
    return `<span class="crest"><img src="${esc(p.teamImage)}" alt="${code}" loading="lazy"></span>`;
  }
  return `<span class="crest"><span class="fb">${code}</span></span>`;
}

/**
 * Eine Spielerkarte.
 *
 * Vier Zonen von oben nach unten: Herkunft, Gesicht, Name, Zahlen. Die
 * Fußleiste trägt genau die zwei Werte, um die es beim Aufstellen geht - was
 * er kostet und was er bringt.
 *
 * Dieselbe Funktion für alle drei Größen: `size` ist "s" auf der Kluft, "" im
 * Markt, "l" in der Auswahl. Ein zweites Bauteil für kleine Karten würde
 * garantiert irgendwann auseinanderlaufen.
 */
function cardHtml(p, opts = {}) {
  const {
    size = "", pts = null, ptsLabel = "Punkte", price = null,
    captain = false, locked = false, owned = false, tag = "",
    action = "", role = null, sub = null,
  } = opts;

  const cls = ["pcard", size, captain ? "cap" : "", locked ? "locked" : "",
    owned ? "owned" : ""].filter(Boolean).join(" ");
  const face = p.image
    ? `<img class="portrait" src="${esc(p.image)}" alt="" loading="lazy">`
    : `<span class="mono-face" aria-hidden="true">${esc((p.name || "?").slice(0, 1).toUpperCase())}</span>`;

  const line = sub !== null ? sub
    : `${ROLE_LABEL[p.role] || p.role || ""}${p.code ? " · " + p.code : ""}`;

  return `
    <div class="${cls} hue" data-hue="${teamHue(p.code || p.team)}">
      ${captain ? '<span class="seal" aria-hidden="true">C</span>' : ""}
      ${tag ? `<span class="tag">${esc(tag)}</span>` : ""}
      <div class="card-top">${leagueCrest(p.league)}${teamCrest(p)}</div>
      ${face}
      <div class="plate">
        <span class="name">${esc(p.name)}</span>
        <span class="sub">${roleIcon(role || p.role)}${esc(line)}</span>
      </div>
      <div class="foot">
        <span class="price"><span class="k">Preis</span><span class="v">${num(price)}</span></span>
        <span class="pts"><span class="k">${esc(ptsLabel)}</span><span class="v">${num(pts)}</span></span>
      </div>
      ${action}
    </div>`;
}

/**
 * Die Farbtöne als CSS-Variable setzen.
 *
 * Unter der strengen CSP (style-src 'self') sind style-Attribute im Markup
 * wirkungslos - der Wert steht deshalb in data-hue und wandert hier in eine
 * Variable.
 */
function paintHues(root) {
  root.querySelectorAll(".hue[data-hue]").forEach(el => {
    el.style.setProperty("--hue", el.getAttribute("data-hue"));
  });
}

/** -0.5 -> "−0,5", 0.02 -> "+0,02". Deutsches Komma, echtes Minuszeichen. */
function fmtFactor(n) {
  const v = Math.round(Number(n) * 1000) / 1000;
  return (v > 0 ? "+" : "") + String(v).replace("-", "−").replace(".", ",");
}

/** Wie fmtFactor, aber immer mit einer Nachkommastelle: "+8,0", "−0,5". */
function fmtSigned(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const s = (Math.abs(v) < 0.005 ? 0 : v).toFixed(Math.abs(v) < 1 && v !== 0 ? 2 : 1);
  return (v > 0 ? "+" : "") + s.replace("-", "−").replace(".", ",");
}

/**
 * Rechnet nach, wofuer es die Punkte einer Spielzeile gab.
 *
 * Das ist bewusst eine reine Anzeige und nie die Quelle der Wahrheit: gewertet
 * wird immer der vom Sammler gespeicherte Wert. Wenn sich die Formel seit dem
 * Spiel geaendert hat, weicht die Summe hier ab - genau dafuer steht der
 * Hinweis in der Detailansicht. Ohne bekannte Formel gibt es keinen Rechenweg,
 * dann bleibt die Zeile eben zugeklappt.
 */
function scoreParts(line) {
  const s = state.scoring;
  if (!s) return null;
  // Fehlende Werte als 0 lesen: eine unvollstaendige Formel darf hoechstens
  // eine Zeile weniger zeigen, aber niemals NaN in die Anzeige schreiben.
  const f = k => Number(s[k]) || 0;
  const parts = [];
  const add = (label, detail, value) => {
    if (Math.abs(value) > 0.0001) parts.push({ label, detail, value });
  };
  add("Kills", `${line.k} × ${fmtFactor(f("kill"))}`, line.k * f("kill"));
  add("Assists", `${line.a} × ${fmtFactor(f("assist"))}`, line.a * f("assist"));
  add("Tode", `${line.d} × ${fmtFactor(f("death"))}`, line.d * f("death"));
  add("Creep Score", `${line.cs} × ${fmtFactor(f("cs"))}`, line.cs * f("cs"));
  if (s.bigGameAt && (line.k >= s.bigGameAt || line.a >= s.bigGameAt)) {
    add("Großes Spiel", `${s.bigGameAt}+ Kills oder Assists`, f("bigGame"));
  }
  if (line.d === 0) add("Kein Tod", "das ganze Spiel", f("deathless"));
  if (line.winBonus) add("Serien-Sieg", "einmal je Match", f("seriesWin"));
  return parts;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Wer angemeldet ist, steht am Telefon oben in der Kopfzeile und am
 * Schreibtisch als Kreis unten in der Leiste - dort passt nur der
 * Anfangsbuchstabe hin.
 */
function setWho() {
  const name = state.user ? state.user.name : "";
  whoEl.textContent = name;
  meEl.textContent = name ? name.slice(0, 1).toUpperCase() : "";
  meEl.title = name;
}

function setMessage(kind, text) {
  state.message = text ? { kind, text } : null;
}

function messageHtml() {
  if (!state.message) return "";
  return `<div class="msg ${esc(state.message.kind)}">${esc(state.message.text)}</div>`;
}

// ---------------------------------------------------------------- Anmeldung

function renderAuth() {
  tabsEl.hidden = true; railEl.hidden = true;
  setWho();
  const login = state.authMode === "login";
  app.innerHTML = `
    <div class="card">
      <h2 class="hd">${login ? "Anmelden" : "Konto anlegen"}</h2>
      <p class="sub">Kader aus echten Profispielern. Punkte gibt es für das,
        was deine Spieler in LEC, LCS, LCK und LPL wirklich abliefern.</p>
      ${messageHtml()}
      <form id="auth-form">
        <label class="field"><span>Name</span>
          <input name="name" autocomplete="username" required maxlength="24"></label>
        <label class="field"><span>Passwort${login ? "" : " (mindestens 8 Zeichen)"}</span>
          <input name="password" type="password" required minlength="8" maxlength="200"
                 autocomplete="${login ? "current-password" : "new-password"}"></label>
        <button class="btn wide" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Moment…" : (login ? "Anmelden" : "Los geht's")}</button>
      </form>
      <p class="switch-row">
        <button class="btn ghost small wide" id="auth-switch" type="button">
          ${login ? "Noch kein Konto? Eins anlegen" : "Schon ein Konto? Anmelden"}
        </button>
      </p>
    </div>`;

  document.getElementById("auth-switch").addEventListener("click", () => {
    state.authMode = login ? "register" : "login";
    setMessage(null, null);
    render();
  });

  document.getElementById("auth-form").addEventListener("submit", async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    state.busy = true; render();
    const res = await api(login ? "/api/login" : "/api/register", {
      method: "POST",
      body: { name: form.get("name"), password: form.get("password") },
    });
    state.busy = false;
    if (!res.ok) {
      setMessage("err", (res.data && res.data.error) || "Das hat nicht geklappt");
      return render();
    }
    setMessage(null, null);
    await loadMe();
  });
}

// ---------------------------------------------------------------- Lobby

function renderLobby() {
  tabsEl.hidden = true; railEl.hidden = true;
  const leagues = state.leagues || [];
  app.innerHTML = `
    ${messageHtml()}
    <div class="card">
      <h2>Deine Ligen</h2>
      ${leagues.length ? leagues.map(l => `
        <button class="prow" data-league="${esc(l.id)}">
          <span class="avatar" aria-hidden="true">${esc(l.name.slice(0, 1).toUpperCase())}</span>
          <span>
            <span class="pname">${esc(l.name)}</span>
            <span class="sub"><br>${l.members} ${l.members === 1 ? "Mitglied" : "Mitglieder"}${l.owner ? " · deine Liga" : ""}</span>
          </span>
          <span class="num"></span><span class="num">›</span>
        </button>`).join("")
        : '<p class="empty">Noch keine Liga. Leg eine an oder tritt einer bei.</p>'}
    </div>

    <div class="card">
      <h2>Neue Liga</h2>
      <form id="create-form" class="row">
        <input class="search" name="name" placeholder="Name der Liga" required maxlength="40">
        <button class="btn" type="submit">Anlegen</button>
      </form>
    </div>

    <div class="card">
      <h2>Einer Liga beitreten</h2>
      <p class="sub">Mit dem 8-stelligen Code aus der Einladung.</p>
      <form id="join-form" class="row">
        <input class="search" name="code" placeholder="ABCD2345" required maxlength="8" autocapitalize="characters">
        <button class="btn" type="submit">Beitreten</button>
      </form>
    </div>

    <div class="card">
      <button class="btn ghost wide" id="logout">Abmelden</button>
    </div>`;

  app.querySelectorAll("[data-league]").forEach(btn => {
    btn.addEventListener("click", () => openLeague(btn.getAttribute("data-league")));
  });

  document.getElementById("create-form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    const res = await api("/api/leagues", { method: "POST", body: { name } });
    if (!res.ok) { setMessage("err", res.data && res.data.error); return render(); }
    await loadMe();
    openLeague(res.data.league.id);
  });

  document.getElementById("join-form").addEventListener("submit", async e => {
    e.preventDefault();
    const code = String(new FormData(e.target).get("code") || "").toUpperCase();
    const res = await api("/api/leagues/join", { method: "POST", body: { code } });
    if (!res.ok) { setMessage("err", res.data && res.data.error); return render(); }
    await loadMe();
    openLeague(res.data.league.id);
  });

  document.getElementById("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null; state.leagues = []; state.leagueId = null; state.league = null;
    render();
  });
}

// ---------------------------------------------------------------- Liga

function renderTabs() {
  tabsEl.hidden = false; railEl.hidden = false;
  const items = [
    { key: "squad", label: "Kader", ic: "★" },
    { key: "market", label: "Markt", ic: "☰" },
    { key: "points", label: "Punkte", ic: "◎" },
    { key: "table", label: "Tabelle", ic: "▤" },
  ];
  tabsEl.innerHTML = items.map(i =>
    `<button data-tab="${i.key}" class="${state.tab === i.key ? "on" : ""}">
       <span class="ic" aria-hidden="true">${i.ic}</span>${i.label}</button>`).join("");
  tabsEl.querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.tab = btn.getAttribute("data-tab");
      setMessage(null, null);
      renderLeague();
    });
  });
}

function leagueHeadHtml() {
  const l = state.league.league;
  const r = state.league.round;
  const me = state.league.me;
  const others = state.league.members.filter(m => !m.you);
  const best = Math.max(...state.league.members.map(m => m.total));
  return `
    <div class="card">
      <div class="row">
        <div>
          <h2 class="hd">${esc(l.name)}</h2>
          <p class="sub">${esc(roundLabel(r.key))}${r.end ? " · endet " + esc(whenLong(r.end)) : ""}</p>
        </div>
        <div class="spacer"></div>
        <button class="btn ghost small" id="switch-league">Wechseln</button>
      </div>
      <table class="tbl">
        <tbody>
          ${state.league.members.map(m => `
            <tr class="${m.you ? "you" : ""}">
              <td>${esc(m.name)}${m.you ? " (du)" : ""}${best > 0 && m.total === best ? " 👑" : ""}
                ${m.hidden ? '<div class="sub">Kader verdeckt</div>' : ""}</td>
              <td class="num big">${num(m.total)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${others.length === 0 ? `<p class="sub">Noch allein hier - lade jemanden ein.</p>` : ""}
    </div>`;
}

/**
 * Die Kluft der Beschwörer als Auswahlfläche.
 *
 * Selbst gezeichnet und nicht Riots Artwork: ein Bild müsste nachgeladen
 * werden, wäre nicht meins und liesse sich nicht einfärben. Ein SVG kostet
 * nichts, bleibt bei jeder Grösse scharf und nutzt dieselben Farbvariablen
 * wie der Rest der Seite.
 *
 * Die Geometrie folgt der echten Karte: quadratisches Feld, roter Nexus unten
 * links, blauer oben rechts, drei Lanes (aussen herum und einmal diagonal),
 * der Fluss quer dazu von oben links nach unten rechts. Die Plätze liegen
 * darauf, wo die Rolle wirklich spielt.
 */
function riftMapSvg() {
  const lane = (d, cls) => `<path d="${d}" class="${cls}"/>`;
  return `
  <svg class="rift-map" viewBox="0 0 100 100" preserveAspectRatio="none"
       aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="rift-ground" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#24331d"/>
        <stop offset="0.5" stop-color="#1d2c20"/>
        <stop offset="1" stop-color="#16211d"/>
      </linearGradient>
      <radialGradient id="rift-red" cx="0.5" cy="0.5">
        <stop offset="0" stop-color="#ff5a48" stop-opacity="0.85"/>
        <stop offset="0.45" stop-color="#ff5a48" stop-opacity="0.28"/>
        <stop offset="1" stop-color="#ff5a48" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="rift-blue" cx="0.5" cy="0.5">
        <stop offset="0" stop-color="#4ab4ff" stop-opacity="0.85"/>
        <stop offset="0.45" stop-color="#4ab4ff" stop-opacity="0.28"/>
        <stop offset="1" stop-color="#4ab4ff" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="rift-fog" cx="0.5" cy="0.5">
        <stop offset="0.6" stop-color="#030507" stop-opacity="0"/>
        <stop offset="1" stop-color="#030507" stop-opacity="0.72"/>
      </radialGradient>
    </defs>

    <rect width="100" height="100" fill="url(#rift-ground)"/>

    <!-- Jungle: die vier Viertel zwischen den Lanes, dunkler als die Wege -->
    <path d="M13 13 H49 L13 49 Z" class="rift-jungle"/>
    <path d="M87 87 H51 L87 51 Z" class="rift-jungle"/>
    <path d="M60 13 H87 V40 Z" class="rift-jungle"/>
    <path d="M40 87 H13 V60 Z" class="rift-jungle"/>

    <!-- Der Fluss quer zur Mid-Lane, von oben links nach unten rechts -->
    <path d="M0 30 L70 100 L84 100 L0 16 Z" class="rift-river"/>

    <!-- Die drei Lanes: aussen herum und einmal quer. Erst ein dunkler Rand,
         damit die hellen Wege sich vom Untergrund abheben. -->
    ${lane("M8 92 V8 H92", "rift-lane-edge")}
    ${lane("M8 92 H92 V8", "rift-lane-edge")}
    ${lane("M14 86 L86 14", "rift-lane-edge")}
    ${lane("M8 92 V8 H92", "rift-lane")}
    ${lane("M8 92 H92 V8", "rift-lane")}
    ${lane("M14 86 L86 14", "rift-lane")}

    <!-- Basen: rot unten links, blau oben rechts, wie im Bild -->
    <circle cx="8" cy="92" r="30" fill="url(#rift-red)"/>
    <circle cx="92" cy="8" r="30" fill="url(#rift-blue)"/>
    <circle cx="8" cy="92" r="4.5" class="rift-nexus red"/>
    <circle cx="92" cy="8" r="4.5" class="rift-nexus blue"/>

    <rect width="100" height="100" fill="url(#rift-fog)"/>
    <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="8" class="rift-rim"/>
  </svg>`;
}

/**
 * Ein Platz auf der Karte. Er sitzt dort, wo die Rolle spielt: Top oben links,
 * Mid in der Mitte, Botlane unten rechts, der Jungler zwischen den Lanes.
 * Das liest sich schneller als fuenf gleiche Zeilen untereinander und macht
 * sofort klar, welche Rolle noch frei ist.
 */
function spotHtml(role, slot) {
  if (!slot) {
    return `
      <div class="spot spot-${role}">
        <button class="pcard s empty" data-pick="${role}" title="Spieler wählen">
          ${roleIcon(role, "role-big")}
          <span class="plus" aria-hidden="true">+</span>
          <span class="what">${esc(ROLE_LABEL[role])}</span>
        </button>
      </div>`;
  }
  const cap = !!slot.captain;
  const card = cardHtml(slot, {
    size: "s",
    role,
    pts: slot.pts * (cap ? 2 : 1),
    ptsLabel: cap ? "Punkte ×2" : "Punkte",
    price: slot.paid,
    captain: cap,
    locked: slot.locked,
    action: `<button class="spot-cap ${cap ? "on" : ""}" data-cap="${role}"
               ${slot.locked ? "disabled" : ""}
               title="Kapitän: doppelte Punkte">C</button>`,
  });
  // Die Karte selbst ist der Knopf zum Tauschen; der Kapitänsknopf liegt
  // darauf und muss den Klick abfangen (siehe wireLeague).
  return `
    <div class="spot spot-${role}">
      <button class="spot-hit" data-pick="${role}" ${slot.locked ? "disabled" : ""}
              title="Tauschen" aria-label="${esc(slot.name)} tauschen"></button>
      ${card}
    </div>`;
}

/**
 * Wann und gegen wen. Steht unter der Karte statt darauf - auf den Plaetzen
 * waere kein Platz dafuer, und untereinander laesst sich die Woche auf einen
 * Blick lesen.
 */
function fixtureRowHtml(role, slot) {
  if (!slot) {
    return `<div class="fx empty"><span class="fx-role">${esc(ROLE_LABEL[role])}</span>
      <span class="fx-who">noch frei</span></div>`;
  }
  const when = slot.locked ? '<span class="fx-lock">läuft schon</span>'
    : slot.kickoff ? esc(whenLong(slot.kickoff))
    : '<span class="fx-none">kein Spiel diese Runde</span>';
  return `
    <div class="fx ${slot.locked ? "locked" : ""}">
      <span class="fx-role">${esc(ROLE_LABEL[role])}</span>
      <span class="fx-who">${esc(slot.code || slot.team)}${
        slot.opponent ? ` <span class="fx-vs">gegen</span> ${esc(slot.opponent)}` : ""}</span>
      <span class="fx-when">${when}</span>
    </div>`;
}

function squadPanelHtml() {
  const me = state.league.me;
  const budget = state.league.league.budget;
  const missing = ROLES.filter(r => !me.slots[r.key]).length;

  let notes = "";
  if (missing) {
    notes += `<div class="msg info">Noch ${missing} ${missing === 1 ? "Platz" : "Plätze"} frei.
      Unbesetzte Plätze bringen keine Punkte.</div>`;
  } else if (!me.captain) {
    notes += `<div class="msg info">Kein Kapitän gesetzt - tippe auf das <b>C</b>,
      der Spieler zählt dann doppelt.</div>`;
  }
  if (me.inherited) {
    notes += `<div class="msg info">Dieser Kader läuft aus einer früheren Runde weiter.
      Er zählt so, wie er ist - ändern kannst du ihn, solange das jeweilige Team
      noch nicht gespielt hat.</div>`;
  }

  return `
    <div class="card">
      <div class="row">
        <h2 class="hd">Dein Kader</h2>
        <div class="spacer"></div>
        <div class="big-pts">${num(me.total)}<span>Punkte</span></div>
      </div>
      ${messageHtml()}
      <div class="budget ${me.cost > budget + 0.001 ? "over" : ""}">
        <div class="bar"><i id="budget-fill"></i></div>
        <div class="num"><b>${num(me.cost)}</b> / ${num(budget)}</div>
      </div>
      <div class="rift">
        ${riftMapSvg()}
        ${ROLES.map(r => spotHtml(r.key, me.slots[r.key])).join("")}
      </div>
      <div class="fixtures">
        <h3>Diese Runde</h3>
        ${ROLES.map(r => fixtureRowHtml(r.key, me.slots[r.key])).join("")}
      </div>
      ${notes}
      <p class="sub">Ein Platz ist gesperrt, sobald das Team des Spielers sein erstes
        Spiel der Runde begonnen hat. Bezahlt wird der Preis vom Zeitpunkt der Wahl.</p>
    </div>`;
}

/** Eine Spielzeile samt Rechenweg: wofuer es die Punkte gab. */
function lineHtml(line, playerId, index) {
  const parts = scoreParts(line);
  const sum = parts ? parts.reduce((a, p) => a + p.value, 0) : null;
  const drifted = sum !== null && Math.abs(sum - line.pts) > 0.05;
  const id = `ln-${esc(playerId)}-${index}`;

  // Der Kopf ist nur ein Knopf, wenn es auch etwas aufzuklappen gibt. Kennt
  // der Server die Formel noch nicht, waere ein Pfeil ins Leere gelogen.
  const body = `
      <span class="ch">${esc(line.champion || "?")}</span>
      <span class="kda">${line.k}/${line.d}/${line.a}</span>
      <span class="cs">${line.cs} CS</span>
      ${line.winBonus ? '<span class="wb">Sieg</span>' : ""}
      <span class="spacer"></span>
      <span class="pt">${num(line.pts)}</span>`;

  if (!parts) return `<div class="line"><div class="line-head flat">${body}</div></div>`;

  const head = `
    <button class="line-head" data-line="${id}" aria-expanded="false" aria-controls="${id}">
      ${body}<span class="caret" aria-hidden="true">▾</span>
    </button>`;

  return `
    <div class="line">
      ${head}
      <div class="line-detail" id="${id}" hidden>
        ${parts.map(p => `
          <div class="part">
            <span class="l">${esc(p.label)}</span>
            <span class="d">${esc(p.detail)}</span>
            <span class="v ${p.value < 0 ? "neg" : ""}">${fmtSigned(p.value)}</span>
          </div>`).join("")}
        <div class="part total">
          <span class="l">Summe</span><span class="d"></span>
          <span class="v">${num(line.pts)}</span>
        </div>
        ${drifted ? `<div class="part note">Die Punkteformel hat sich seit diesem
          Spiel geändert - gewertet wird der gespeicherte Wert.</div>` : ""}
      </div>
    </div>`;
}

function breakdownRowsHtml(member, withLines) {
  const bd = state.breakdown || {};
  return ROLES.map(r => {
    const slot = member.slots[r.key];
    if (!slot) {
      return `<tr><td>${esc(r.label)}<div class="sub">frei</div></td>
              <td class="num">–</td><td class="num big">0.0</td></tr>`;
    }
    const mult = slot.captain ? 2 : 1;
    const lines = withLines ? (bd.lines || []).filter(l => l.playerId === slot.playerId) : [];
    return `
      <tr>
        <td>
          <div class="pl">${esc(slot.name)}${mult > 1 ? ' <span class="x2">×2</span>' : ""}</div>
          <div class="sub">${esc(ROLE_LABEL[r.key])} · ${esc(slot.code || slot.team)} ·
            ${slot.games} ${slot.games === 1 ? "Spiel" : "Spiele"}</div>
          ${lines.map((l, i) => lineHtml(l, slot.playerId, i)).join("")}
        </td>
        <td class="num">${num(slot.pts)}</td>
        <td class="num big">${num(slot.pts * mult)}</td>
      </tr>`;
  }).join("");
}

function pointsPanelHtml() {
  const league = state.league;
  const mine = league.me;
  const others = league.members.filter(m => !m.you);

  const legend = state.scoring ? `
    <p class="sub">Kill ${fmtFactor(state.scoring.kill)} ·
      Assist ${fmtFactor(state.scoring.assist)} ·
      Tod ${fmtFactor(state.scoring.death)} ·
      je Creep ${fmtFactor(state.scoring.cs)} ·
      ${state.scoring.bigGameAt}+ Kills/Assists ${fmtFactor(state.scoring.bigGame)} ·
      ohne Tod ${fmtFactor(state.scoring.deathless)} ·
      Serien-Sieg ${fmtFactor(state.scoring.seriesWin)}</p>` : "";

  return `
    <div class="card">
      <div class="row">
        <h2 class="hd">Deine Punkte</h2>
        <div class="spacer"></div>
        <div class="big-pts">${num(mine.total)}<span>${esc(roundLabel(league.round.key))}</span></div>
      </div>
      <p class="sub">Tippe auf ein Spiel, um zu sehen, wofür es die Punkte gab.</p>
      <table class="tbl">
        <thead><tr><th>Spieler</th><th class="num">Roh</th><th class="num">Punkte</th></tr></thead>
        <tbody>${breakdownRowsHtml(mine, true)}</tbody>
        <tfoot><tr><td><b>Summe</b></td><td class="num"></td>
          <td class="num big">${num(mine.total)}</td></tr></tfoot>
      </table>
      ${legend}
    </div>
    ${others.map(m => m.hidden ? `
      <div class="card"><h2 class="hd">${esc(m.name)}</h2>
        <p class="empty">Verdeckt, bis dein eigener Kader vollständig ist.
          Punktestand: <b>${num(m.total)}</b></p></div>`
      : `
      <div class="card">
        <div class="row"><h2 class="hd">${esc(m.name)}</h2><div class="spacer"></div>
          <div class="big-pts">${num(m.total)}<span>Punkte</span></div></div>
        <table class="tbl"><tbody>${breakdownRowsHtml(m, false)}</tbody></table>
      </div>`).join("")}`;
}

let marketFilter = { role: "", league: "", q: "", sort: "price", desc: true,
                     view: "cards" };

/**
 * Die Spalten des Marktes. Jede weiss, wie sie sortiert und wie sie sich
 * darstellt - dann bleibt die Tabelle eine Schleife statt fuenf Sonderfaelle.
 */
const MARKET_COLS = [
  { key: "price", head: "Preis", title: "Preis in Millionen",
    value: p => p.price, cell: p => `<b>${num(p.price)}</b>` },
  { key: "season", head: "Punkte", short: "Pkt", title: "Punkte diese Saison",
    value: p => p.season, cell: p => num(p.season) },
  // Der Schnitt ist die vierte Zahl in einer Reihe - am Telefon passt sie
  // nicht mehr daneben, und im Auswahlfenster steht sie ohnehin.
  { key: "avg", head: "Ø", title: "Punkte je Runde mit Einsatz", opt: true,
    value: p => p.avg, cell: p => num(p.avg) },
  { key: "picked", head: "Gewählt", short: "Wahl", title: "Anteil der Liga mit diesem Spieler",
    value: p => p.picked, cell: (p, market) => pct(p.picked, market.members) },
];

function pct(part, total) {
  if (!total) return "0 %";
  return Math.round((part / total) * 100) + " %";
}

/**
 * Wodurch ein Spieler seine Punkte hat - je Spiel gerechnet, damit sich
 * jemand mit 30 Spielen und jemand mit 8 vergleichen lassen.
 *
 * "Ø 18.4" allein sagt nur, dass jemand gut ist. Dieser Balken sagt warum:
 * ein Support mit lauter Assists sieht anders aus als ein Midlaner mit
 * Kills, und wer seine Punkte hauptsaechlich aus Creep Score zieht, ist
 * verlaesslich statt spektakulaer.
 */
function pointSources(p) {
  const s = state.scoring;
  if (!s || !p.kda || !p.games) return null;
  const g = p.games;
  const parts = [
    { key: "k", label: "Kills", short: "K", value: (p.kda.k || 0) * (Number(s.kill) || 0) },
    { key: "a", label: "Assists", short: "A", value: (p.kda.a || 0) * (Number(s.assist) || 0) },
    { key: "cs", label: "Creep Score", short: "CS", value: (p.kda.cs || 0) * (Number(s.cs) || 0) },
    { key: "w", label: "Siege", short: "S", value: (p.kda.wins || 0) * (Number(s.seriesWin) || 0) },
  ].filter(part => part.value > 0.05);
  const sum = parts.reduce((a, part) => a + part.value, 0);
  if (!sum) return null;
  return {
    perGame: parts.map(part => ({ ...part, perGame: part.value / g, share: part.value / sum })),
    kda: `${(p.kda.k / g).toFixed(1)}/${(p.kda.d / g).toFixed(1)}/${(p.kda.a / g).toFixed(1)}`,
    cs: Math.round(p.kda.cs / g),
  };
}

function sourcesHtml(p) {
  const src = pointSources(p);
  if (!src) return "";
  return `
    <span class="src">
      <span class="src-bar">${src.perGame.map(part =>
        `<i class="s-${part.key}" data-w="${Math.round(part.share * 100)}"
            title="${esc(part.label)}: ${fmtSigned(part.perGame)} je Spiel"></i>`).join("")}</span>
      <span class="src-txt">${esc(src.kda)} · ${src.cs} CS${
        p.kda.wins ? ` · ${p.kda.wins}× Sieg` : ""}</span>
    </span>`;
}

/**
 * Die Anteile der Herkunftsbalken als CSS-Variable setzen.
 *
 * Die strenge CSP verwirft style-Attribute im Markup, deshalb steht der
 * Prozentwert in data-w und wandert hier in eine Variable.
 */
function paintSourceBars(root) {
  root.querySelectorAll(".src-bar i[data-w]").forEach(bar => {
    bar.style.setProperty("--w", bar.getAttribute("data-w") + "%");
  });
}

function marketPanelHtml() {
  const market = state.market;
  if (!market) return '<div class="card"><p class="loading">Lade Markt…</p></div>';

  const leagues = [...new Set(market.players.map(p => p.league).filter(Boolean))].sort();
  const now = Math.floor(Date.now() / 1000);
  const q = marketFilter.q.toLowerCase();
  const col = MARKET_COLS.find(c => c.key === marketFilter.sort) || MARKET_COLS[0];
  const dir = marketFilter.desc ? -1 : 1;

  const matching = market.players.filter(p =>
    (!marketFilter.role || p.role === marketFilter.role) &&
    (!marketFilter.league || p.league === marketFilter.league) &&
    (!q || `${p.name} ${p.team} ${p.code}`.toLowerCase().includes(q))
  );
  // Gleichstand nach Namen aufloesen, sonst springen Zeilen bei jedem
  // Neuzeichnen umher.
  const list = matching.slice().sort((a, b) => {
    const d = (col.value(a) - col.value(b)) * dir;
    return d || a.name.localeCompare(b.name);
  }).slice(0, 150);

  // Am Telefon steht die Kurzform des Spaltennamens - beide sind im Markup,
  // welche zu sehen ist, entscheidet das Stylesheet.
  const head = MARKET_COLS.map(c => `
    <th class="num sortable ${c.opt ? "opt" : ""} ${c.key === col.key ? "on" : ""}" title="${esc(c.title)}">
      <button data-msort="${c.key}"><span class="lg">${esc(c.head)}</span><span
        class="sm">${esc(c.short || c.head)}</span><span class="arr">${
        c.key === col.key ? (marketFilter.desc ? "▾" : "▴") : ""}</span></button>
    </th>`).join("");

  return `
    <div class="card">
      <div class="row">
        <h2 class="hd">Spielermarkt</h2>
        <div class="spacer"></div>
        <div class="viewswitch">
          <button class="chip ${marketFilter.view === "cards" ? "on" : ""}" data-mview="cards">Karten</button>
          <button class="chip ${marketFilter.view === "table" ? "on" : ""}" data-mview="table">Tabelle</button>
        </div>
      </div>
      <p class="sub">Antippen setzt den Spieler auf seine Position in deinem Kader.
        ${marketFilter.view === "table" ? "Über die Spaltenköpfe sortieren."
          : "Zum Vergleichen vieler Spieler ist die Tabelle besser."}</p>
      ${messageHtml()}
      <input class="search" id="market-q" placeholder="Name oder Team" value="${esc(marketFilter.q)}">
      <div class="filters">
        <button class="chip ${!marketFilter.role ? "on" : ""}" data-mrole="">Alle</button>
        ${ROLES.map(r => `<button class="chip ${marketFilter.role === r.key ? "on" : ""}" data-mrole="${r.key}">${r.label}</button>`).join("")}
      </div>
      <div class="filters">
        <button class="chip ${!marketFilter.league ? "on" : ""}" data-mleague="">Alle Ligen</button>
        ${leagues.map(l => `<button class="chip ${marketFilter.league === l ? "on" : ""}" data-mleague="${esc(l)}">${esc(l)}</button>`).join("")}
      </div>
      ${!list.length ? '<p class="empty">Niemand gefunden.</p>' : marketFilter.view === "cards" ? `
      <div class="cardgrid">
        ${list.map(p => {
          const locked = p.kickoff && p.kickoff <= now;
          const mine = state.league.me.slots[p.role];
          const owned = mine && mine.playerId === p.id;
          return cardHtml(p, {
            pts: p.season, ptsLabel: "Saison", price: p.price,
            locked, owned,
            tag: owned ? "Im Kader" : locked ? "Gesperrt" : "",
            sub: `${ROLE_LABEL[p.role] || p.role} · ${p.code || p.team}`
              + (locked ? "" : p.kickoff
                  ? ` · ${whenShort(p.kickoff)}${p.opponent ? " gegen " + p.opponent : ""}`
                  : " · kein Spiel"),
            action: `<button class="card-hit" data-market="${esc(p.id)}" data-role="${esc(p.role)}"
                       ${locked ? "disabled" : ""}
                       aria-label="${esc(p.name)} wählen"></button>`,
          });
        }).join("")}
      </div>` : `
      <div class="tscroll">
        <table class="tbl market">
          <thead><tr><th>Spieler</th>${head}</tr></thead>
          <tbody>
            ${list.map(p => {
              const locked = p.kickoff && p.kickoff <= now;
              const mine = state.league.me.slots[p.role];
              const owned = mine && mine.playerId === p.id;
              return `
              <tr class="${locked ? "off" : ""} ${owned ? "on" : ""}">
                <td class="who">
                  <button class="pbtn" data-market="${esc(p.id)}" data-role="${esc(p.role)}" ${locked ? "disabled" : ""}>
                    ${avatar(p)}
                    <span class="pmeta">
                      <span class="pname">${esc(p.name)}</span>
                      <span class="line2">${esc(ROLE_LABEL[p.role] || p.role)} · ${esc(p.code || p.team)}
                        ${owned ? ' · <span class="own">im Kader</span>' : ""}
                        ${locked ? ' · <span class="lock">gesperrt</span>'
                          : p.kickoff ? ` · ${esc(whenShort(p.kickoff))}${
                              p.opponent ? " gegen " + esc(p.opponent) : ""}`
                          : " · kein Spiel"}</span>
                      ${sourcesHtml(p)}
                    </span>
                  </button>
                </td>
                ${MARKET_COLS.map(c => `<td class="num ${c.opt ? "opt" : ""} ${
                  c.key === col.key ? "on" : ""}">${c.cell(p, market)}</td>`).join("")}
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <p class="src-legend">Der Balken zeigt, wodurch die Punkte zustande kommen:
        <span class="k">Kills</span>, <span class="a">Assists</span>,
        <span class="cs">Creep Score</span>, <span class="w">Siege</span>.
        Die Zahlen darunter sind der Schnitt je Spiel.</p>
      ${matching.length > list.length ? `<p class="sub">${matching.length - list.length}
        weitere - grenze die Suche ein.</p>` : ""}`}
    </div>`;
}

function tablePanelHtml() {
  const st = state.standings;
  if (!st) return '<div class="card"><p class="loading">Lade Tabelle…</p></div>';
  return `
    <div class="card">
      <h2>Gesamtwertung</h2>
      <table class="tbl">
        <thead><tr><th></th><th>Manager</th><th class="num">Runden</th><th class="num">Punkte</th></tr></thead>
        <tbody>
          ${st.table.map((m, i) => `
            <tr class="${m.you ? "you" : ""}">
              <td class="rank">${i + 1}</td>
              <td>${esc(m.name)}${m.you ? " (du)" : ""}</td>
              <td class="num">${m.history.length}</td>
              <td class="num big">${num(m.total)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="card">
      <h2>Runde für Runde</h2>
      ${st.table.length && st.table[0].history.length ? `
        <table class="tbl">
          <thead><tr><th>Runde</th>${st.table.map(m => `<th class="num">${esc(m.name)}</th>`).join("")}</tr></thead>
          <tbody>
            ${st.table[0].history.slice().reverse().map(h => `
              <tr><td>${esc(roundLabel(h.roundKey))}</td>
                ${st.table.map(m => {
                  const entry = m.history.find(x => x.roundKey === h.roundKey);
                  return `<td class="num">${entry ? num(entry.pts) : "–"}</td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>` : '<p class="empty">Noch keine abgeschlossene Runde.</p>'}
    </div>`;
}

function renderLeague() {
  if (!state.league) { app.innerHTML = '<p class="loading">Lade Liga…</p>'; return; }
  renderTabs();
  setWho();

  const panels = {
    squad: squadPanelHtml,
    market: marketPanelHtml,
    points: pointsPanelHtml,
    table: tablePanelHtml,
  };
  app.innerHTML = leagueHeadHtml() + panels[state.tab]()
    + (state.league.league.inviteCode ? `
      <div class="card">
        <h2>Einladen</h2>
        <p class="sub">Wer diesen Code eingibt, ist dabei.</p>
        <div class="code">${esc(state.league.league.inviteCode)}</div>
        <div class="row">
          <button class="btn ghost small wide" id="copy-invite">Einladungstext kopieren</button>
        </div>
      </div>` : "");

  wireLeague();
}

function wireLeague() {
  const switchBtn = document.getElementById("switch-league");
  if (switchBtn) switchBtn.addEventListener("click", () => {
    state.leagueId = null; state.league = null; state.market = null; state.standings = null;
    render();
  });

  paintHues(app);
  paintSourceBars(app);

  // Budgetbalken: Breite als CSS-Variable, damit kein Inline-Style nötig ist.
  const fill = document.getElementById("budget-fill");
  if (fill && state.league) {
    const pct = Math.min(100, (state.league.me.cost / state.league.league.budget) * 100);
    fill.style.setProperty("--fill", pct.toFixed(1) + "%");
  }

  app.querySelectorAll("[data-pick]").forEach(btn =>
    btn.addEventListener("click", () => openPicker(btn.getAttribute("data-pick"))));

  app.querySelectorAll("[data-cap]").forEach(btn =>
    btn.addEventListener("click", async () => {
      const role = btn.getAttribute("data-cap");
      const current = state.league.me.captain;
      await saveSquad({ captain: current === role ? null : role });
    }));

  app.querySelectorAll("[data-market]").forEach(btn =>
    btn.addEventListener("click", async () => {
      await saveSquad({ role: btn.getAttribute("data-role"), playerId: btn.getAttribute("data-market") });
    }));

  const q = document.getElementById("market-q");
  if (q) q.addEventListener("input", () => {
    marketFilter.q = q.value;
    const pos = q.selectionStart;
    renderLeague();
    const again = document.getElementById("market-q");
    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  });

  app.querySelectorAll("[data-mview]").forEach(btn =>
    btn.addEventListener("click", () => {
      marketFilter.view = btn.getAttribute("data-mview");
      renderLeague();
    }));

  app.querySelectorAll("[data-mrole]").forEach(btn =>
    btn.addEventListener("click", () => { marketFilter.role = btn.getAttribute("data-mrole"); renderLeague(); }));
  app.querySelectorAll("[data-mleague]").forEach(btn =>
    btn.addEventListener("click", () => { marketFilter.league = btn.getAttribute("data-mleague"); renderLeague(); }));

  // Nochmal auf dieselbe Spalte dreht die Richtung um; eine neue Spalte
  // startet absteigend - bei Preis und Punkten will man immer erst oben suchen.
  app.querySelectorAll("[data-msort]").forEach(btn =>
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-msort");
      if (marketFilter.sort === key) marketFilter.desc = !marketFilter.desc;
      else { marketFilter.sort = key; marketFilter.desc = true; }
      renderLeague();
    }));

  // Rechenweg auf- und zuklappen. Ohne Neuzeichnen, sonst verliert man beim
  // Auffalten die Scrollposition in einer langen Punkteliste.
  app.querySelectorAll("[data-line]").forEach(btn =>
    btn.addEventListener("click", () => {
      const detail = document.getElementById(btn.getAttribute("data-line"));
      if (!detail) return;
      detail.hidden = !detail.hidden;
      btn.classList.toggle("open", !detail.hidden);
      btn.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
    }));

  const copy = document.getElementById("copy-invite");
  if (copy) copy.addEventListener("click", async () => {
    const text = `Spiel mit in "${state.league.league.name}" bei Fantasy LoL: `
      + `${location.origin} - Code: ${state.league.league.inviteCode}`;
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Kopiert ✓";
    } catch (e) {
      copy.textContent = "Kopieren ging nicht";
    }
  });
}

// ---------------------------------------------------------------- Auswahl-Sheet

const sheet = document.getElementById("sheet");
const sheetBack = document.getElementById("sheet-back");
let picker = null; // { role, q }

function openSheet() {
  sheet.classList.add("open");
  sheetBack.classList.add("open");
}

function closeSheet() {
  sheet.classList.remove("open");
  sheetBack.classList.remove("open");
  picker = null;
}

async function openPicker(role) {
  picker = { role, q: "" };
  document.getElementById("sheet-title").textContent = ROLE_LABEL[role] + " wählen";
  document.getElementById("sheet-search").value = "";
  if (!state.market) await loadMarket();
  renderPicker();
  openSheet();
}

function renderPicker() {
  if (!picker) return;
  const list = document.getElementById("sheet-list");
  const subEl = document.getElementById("sheet-sub");
  const filtersEl = document.getElementById("sheet-filters");
  const market = state.market;
  if (!market) { list.innerHTML = '<p class="loading">Lade…</p>'; return; }

  const me = state.league.me;
  const budget = state.league.league.budget;
  const spentElsewhere = ROLES.reduce((sum, r) =>
    sum + (r.key !== picker.role && me.slots[r.key] ? me.slots[r.key].paid : 0), 0);
  const remaining = Math.round((budget - spentElsewhere) * 10) / 10;
  const current = me.slots[picker.role] ? me.slots[picker.role].playerId : null;
  const now = Math.floor(Date.now() / 1000);

  subEl.innerHTML = `Noch <b>${num(remaining)}</b> von ${num(budget)} für diesen Platz.`;

  const leagues = [...new Set(market.players.map(p => p.league).filter(Boolean))].sort();
  filtersEl.innerHTML = `<button class="chip ${!picker.league ? "on" : ""}" data-pleague="">Alle</button>`
    + leagues.map(l => `<button class="chip ${picker.league === l ? "on" : ""}" data-pleague="${esc(l)}">${esc(l)}</button>`).join("");
  filtersEl.querySelectorAll("[data-pleague]").forEach(btn =>
    btn.addEventListener("click", () => { picker.league = btn.getAttribute("data-pleague"); renderPicker(); }));

  const q = (picker.q || "").toLowerCase();
  const rows = market.players
    .filter(p => p.role === picker.role)
    .filter(p => !picker.league || p.league === picker.league)
    .filter(p => !q || `${p.name} ${p.team} ${p.code}`.toLowerCase().includes(q))
    .map(p => ({
      ...p,
      locked: !!p.kickoff && p.kickoff <= now,
      tooDear: p.price > remaining + 0.001,
    }));

  const affordable = rows.filter(p => !p.locked && !p.tooDear).length;
  const hint = rows.length && affordable === 0
    ? `<div class="msg err">Kein Spieler passt in die restlichen ${num(remaining)}.
       Tausche zuerst auf einem anderen Platz jemanden Günstigeren ein.</div>`
    : "";

  list.innerHTML = hint + (rows.length ? `<div class="cardgrid">` + rows.map(p => {
    const off = p.locked || p.tooDear;
    const why = p.locked ? "Team hat gespielt"
      : p.tooDear ? "zu teuer"
      : p.kickoff ? whenShort(p.kickoff) + (p.opponent ? " gegen " + p.opponent : "")
      : "kein Spiel";
    return cardHtml(p, {
      pts: p.season, ptsLabel: "Saison", price: p.price,
      locked: off, owned: p.id === current,
      tag: p.id === current ? "Im Kader" : p.tooDear ? "Zu teuer" : p.locked ? "Gesperrt" : "",
      sub: `${p.code || p.team} · ${why}`,
      action: `<button class="card-hit" data-pid="${esc(p.id)}" ${off ? "disabled" : ""}
                 aria-label="${esc(p.name)} wählen"></button>`,
    });
  }).join("") + `</div>` : '<p class="empty">Niemand gefunden.</p>');

  paintHues(list);
  paintSourceBars(list);

  list.querySelectorAll("[data-pid]").forEach(btn =>
    btn.addEventListener("click", async () => {
      const playerId = btn.getAttribute("data-pid");
      const role = picker.role;
      closeSheet();
      await saveSquad({ role, playerId });
    }));
}

document.getElementById("sheet-close").addEventListener("click", closeSheet);
sheetBack.addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
document.getElementById("sheet-search").addEventListener("input", e => {
  if (!picker) return;
  picker.q = e.target.value;
  renderPicker();
});

// ---------------------------------------------------------------- Laden

async function saveSquad(change) {
  const res = await api(`/api/leagues/${state.leagueId}/squad`, { method: "PUT", body: change });
  if (!res.ok) {
    setMessage("err", (res.data && res.data.error) || "Konnte nicht gespeichert werden");
    return renderLeague();
  }
  setMessage(null, null);
  state.league = res.data;
  if (res.data.scoring) state.scoring = res.data.scoring;
  // Ein Wechsel aendert die Spielzeilen, die Gesamtwertung und die Spalte
  // "Gewählt" im Markt. Was gerade zu sehen ist, wird sofort nachgeladen; der
  // Rest wird verworfen, damit beim naechsten Reiterwechsel nichts Altes
  // stehenbleibt.
  state.breakdown = null;
  state.standings = null;
  state.market = null;
  if (state.tab === "points") await loadBreakdown();
  else if (state.tab === "table") await loadStandings();
  else if (state.tab === "market") await loadMarket();
  renderLeague();
}

async function loadMarket() {
  const res = await api(`/api/leagues/${state.leagueId}/market`);
  if (res.ok) {
    state.market = res.data;
    if (res.data.scoring) state.scoring = res.data.scoring;
  }
}

async function loadStandings() {
  const res = await api(`/api/leagues/${state.leagueId}/standings`);
  if (res.ok) state.standings = res.data;
}

async function loadBreakdown() {
  const res = await api(`/api/leagues/${state.leagueId}/breakdown`);
  state.breakdown = res.ok ? res.data : { lines: [] };
}

async function openLeague(id) {
  state.leagueId = id;
  state.market = null;
  state.standings = null;
  state.breakdown = null;
  state.tab = "squad";
  setMessage(null, null);
  app.innerHTML = '<p class="loading">Lade Liga…</p>';
  const res = await api(`/api/leagues/${id}`);
  if (res.ok && res.data.scoring) state.scoring = res.data.scoring;
  if (!res.ok) {
    state.leagueId = null;
    setMessage("err", (res.data && res.data.error) || "Liga nicht erreichbar");
    return render();
  }
  state.league = res.data;
  renderLeague();
  // Der Rest darf nachladen - der Kader ist sofort da.
  loadMarket().then(() => { if (state.tab === "market") renderLeague(); });
  loadStandings().then(() => { if (state.tab === "table") renderLeague(); });
  loadBreakdown().then(() => { if (state.tab === "points") renderLeague(); });
}

async function loadMe() {
  const res = await api("/api/me");
  if (res.data && res.data.build) {
    state.build = res.data.build;
    document.getElementById("build").textContent = "v" + res.data.build;
  }
  if (!res.ok || !res.data.user) { state.user = null; return render(); }
  state.user = res.data.user;
  state.leagues = res.data.leagues || [];
  // Nur eine Liga? Dann direkt hinein, der Umweg über die Lobby nervt.
  if (!state.leagueId && state.leagues.length === 1) return openLeague(state.leagues[0].id);
  render();
}

function render() {
  setWho();
  if (!state.user) return renderAuth();
  if (!state.leagueId || !state.league) { tabsEl.hidden = true; railEl.hidden = true; return renderLobby(); }
  renderLeague();
}

// Wechselt der Nutzer den Reiter, muss das Nachgeladene stimmen.
tabsEl.addEventListener("click", () => {
  if (state.tab === "market" && !state.market) loadMarket().then(renderLeague);
  if (state.tab === "table" && !state.standings) loadStandings().then(renderLeague);
  if (state.tab === "points" && !state.breakdown) loadBreakdown().then(renderLeague);
});

loadMe();

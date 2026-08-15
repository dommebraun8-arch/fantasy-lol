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
  user: null,
  leagues: [],
  leagueId: null,
  league: null,      // Antwort von GET /api/leagues/:id
  market: null,
  standings: null,
  breakdown: null,
  tab: "squad",
  authMode: "login",
  message: null,     // { kind: "err" | "ok" | "info", text }
  busy: false,
};

const app = document.getElementById("app");
const tabsEl = document.getElementById("tabs");
const whoEl = document.getElementById("who");

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

function setMessage(kind, text) {
  state.message = text ? { kind, text } : null;
}

function messageHtml() {
  if (!state.message) return "";
  return `<div class="msg ${esc(state.message.kind)}">${esc(state.message.text)}</div>`;
}

// ---------------------------------------------------------------- Anmeldung

function renderAuth() {
  tabsEl.hidden = true;
  whoEl.textContent = "";
  const login = state.authMode === "login";
  app.innerHTML = `
    <div class="card">
      <h2>${login ? "Anmelden" : "Konto anlegen"}</h2>
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
  tabsEl.hidden = true;
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
  tabsEl.hidden = false;
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
          <h2>${esc(l.name)}</h2>
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

function slotHtml(role, slot) {
  const filled = !!slot;
  const locked = filled && slot.locked;
  const cap = filled && slot.captain;
  const pts = filled ? slot.pts * (cap ? 2 : 1) : 0;

  let line2, name;
  if (!filled) {
    name = '<span class="pname">frei</span>';
    line2 = '<span class="line2">noch nicht besetzt</span>';
  } else {
    name = `<span class="pname">${esc(slot.name)}</span>`;
    const when = locked
      ? '<span class="lock">gesperrt</span>'
      : (slot.kickoff ? `<span class="free">frei bis ${esc(whenShort(slot.kickoff))}</span>` : "kein Spiel");
    line2 = `<span class="line2">${esc(slot.code || slot.team)} · <span class="price">${num(slot.paid)}</span> · ${when}</span>`;
  }

  return `
    <div class="slot ${cap ? "cap" : ""} ${locked ? "locked" : ""}">
      <div class="role">${esc(ROLE_LABEL[role])}${cap ? "<br>C" : ""}</div>
      <div class="player">${filled ? avatar(slot) : '<span class="avatar" aria-hidden="true">·</span>'}
        <span class="pmeta">${name}${line2}</span></div>
      <div class="pts ${pts ? "" : "zero"}">${num(pts)}</div>
      <div class="actions">
        <button class="btn ghost small" data-cap="${role}" ${!filled || locked ? "disabled" : ""}
          title="Kapitän: doppelte Punkte">${cap ? "Kapitän ✓" : "Kapitän"}</button>
        <button class="btn small" data-pick="${role}" ${locked ? "disabled" : ""}>${filled ? "Tauschen" : "Wählen"}</button>
      </div>
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
    notes += `<div class="msg info">Kein Kapitän gesetzt - der bringt doppelte Punkte.</div>`;
  }
  if (me.inherited) {
    notes += `<div class="msg info">Dieser Kader läuft aus einer früheren Runde weiter.
      Er zählt so, wie er ist - ändern kannst du ihn, solange das jeweilige Team noch nicht gespielt hat.</div>`;
  }

  return `
    <div class="card">
      <h2>Dein Kader</h2>
      ${messageHtml()}
      <div class="budget ${me.cost > budget + 0.001 ? "over" : ""}" id="budget">
        <div class="bar"><i id="budget-fill"></i></div>
        <div class="num"><b>${num(me.cost)}</b> / ${num(budget)}</div>
      </div>
      ${ROLES.map(r => slotHtml(r.key, me.slots[r.key])).join("")}
      ${notes}
      <p class="sub">Ein Platz ist gesperrt, sobald das Team des Spielers sein
        erstes Spiel der Runde begonnen hat. Bezahlt wird der Preis vom Zeitpunkt der Wahl.</p>
    </div>`;
}

function pointsPanelHtml() {
  const league = state.league;
  const bd = state.breakdown || {};
  const linesFor = pid => (bd.lines || []).filter(l => l.playerId === pid);

  const mine = league.me;
  const rows = ROLES.map(r => {
    const slot = mine.slots[r.key];
    if (!slot) return `<tr><td>${esc(r.label)}<div class="sub">frei</div></td><td class="num">–</td><td class="num big">0.0</td></tr>`;
    const mult = slot.captain ? 2 : 1;
    const lines = linesFor(slot.playerId).map(l => `
      <div class="gameline"><span>${esc(l.champion || "?")}</span>
        <span>${l.k}/${l.d}/${l.a}</span><span>${l.cs} CS</span>
        ${l.winBonus ? '<span class="wb">Serien-Sieg</span>' : ""}
        <span class="pt">${num(l.pts)}</span></div>`).join("");
    return `
      <tr>
        <td>${esc(slot.name)}${mult > 1 ? ' <span class="pt">×2</span>' : ""}
          <div class="sub">${esc(ROLE_LABEL[r.key])} · ${esc(slot.code || slot.team)} · ${slot.games} ${slot.games === 1 ? "Spiel" : "Spiele"}</div>
          ${lines}</td>
        <td class="num">${num(slot.pts)}</td>
        <td class="num big">${num(slot.pts * mult)}</td>
      </tr>`;
  }).join("");

  const others = league.members.filter(m => !m.you).map(m => {
    if (m.hidden) {
      return `<div class="card"><h2>${esc(m.name)}</h2>
        <p class="empty">Verdeckt, bis dein eigener Kader vollständig ist. Punktestand: <b>${num(m.total)}</b></p></div>`;
    }
    return `<div class="card"><h2>${esc(m.name)} · ${num(m.total)}</h2>
      <table class="tbl"><tbody>
        ${ROLES.map(r => {
          const s = m.slots[r.key];
          if (!s) return `<tr><td>${esc(r.label)}<div class="sub">frei</div></td><td class="num">0.0</td></tr>`;
          return `<tr><td>${esc(s.name)}${s.captain ? ' <span class="pt">×2</span>' : ""}
            <div class="sub">${esc(ROLE_LABEL[r.key])} · ${esc(s.code || s.team)}</div></td>
            <td class="num big">${num(s.pts * (s.captain ? 2 : 1))}</td></tr>`;
        }).join("")}
      </tbody></table></div>`;
  }).join("");

  return `
    <div class="card">
      <h2>Deine Punkte · ${esc(roundLabel(league.round.key))}</h2>
      <table class="tbl">
        <thead><tr><th>Spieler</th><th class="num">Roh</th><th class="num">Punkte</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td><b>Summe</b></td><td class="num"></td><td class="num big">${num(mine.total)}</td></tr></tfoot>
      </table>
    </div>
    ${others}`;
}

let marketFilter = { role: "", league: "", q: "" };

function marketPanelHtml() {
  const market = state.market;
  if (!market) return '<div class="card"><p class="loading">Lade Markt…</p></div>';

  const leagues = [...new Set(market.players.map(p => p.league).filter(Boolean))].sort();
  const now = Math.floor(Date.now() / 1000);
  const q = marketFilter.q.toLowerCase();
  const list = market.players.filter(p =>
    (!marketFilter.role || p.role === marketFilter.role) &&
    (!marketFilter.league || p.league === marketFilter.league) &&
    (!q || `${p.name} ${p.team} ${p.code}`.toLowerCase().includes(q))
  ).slice(0, 150);

  return `
    <div class="card">
      <h2>Spielermarkt</h2>
      <p class="sub">Antippen setzt den Spieler auf seine Position in deinem Kader.</p>
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
      <div class="plist">
        ${list.length ? list.map(p => {
          const locked = p.kickoff && p.kickoff <= now;
          return `
          <button class="prow ${locked ? "off" : ""}" data-market="${esc(p.id)}" data-role="${esc(p.role)}" ${locked ? "disabled" : ""}>
            ${avatar(p)}
            <span><span class="pname">${esc(p.name)}</span>
              <span class="sub"><br>${esc(ROLE_LABEL[p.role] || p.role)} · ${esc(p.code || p.team)} · ${esc(p.league || "")}
              ${locked ? " · gesperrt" : (p.kickoff ? " · " + esc(whenShort(p.kickoff)) : " · kein Spiel")}</span></span>
            <span class="num">Ø ${num(p.avg)}<br><span class="sub">${p.games} Sp.</span></span>
            <span class="num"><b>${num(p.price)}</b></span>
          </button>`;
        }).join("") : '<p class="empty">Niemand gefunden.</p>'}
      </div>
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
  whoEl.textContent = state.user ? state.user.name : "";

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

  app.querySelectorAll("[data-mrole]").forEach(btn =>
    btn.addEventListener("click", () => { marketFilter.role = btn.getAttribute("data-mrole"); renderLeague(); }));
  app.querySelectorAll("[data-mleague]").forEach(btn =>
    btn.addEventListener("click", () => { marketFilter.league = btn.getAttribute("data-mleague"); renderLeague(); }));

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

  list.innerHTML = hint + (rows.length ? rows.map(p => {
    const off = p.locked || p.tooDear;
    const why = p.locked ? "Team hat gespielt"
      : p.tooDear ? "zu teuer"
      : (p.kickoff ? whenShort(p.kickoff) : "kein Spiel");
    return `
      <button class="prow ${off ? "off" : ""} ${p.id === current ? "on" : ""}"
              data-pid="${esc(p.id)}" ${off ? "disabled" : ""}>
        ${avatar(p)}
        <span><span class="pname">${esc(p.name)}</span>
          <span class="sub"><br>${esc(p.code || p.team)} · ${esc(p.league || "")} · ${esc(why)}</span></span>
        <span class="num">Ø ${num(p.avg)}<br><span class="sub">${p.games} Sp.</span></span>
        <span class="num"><b>${num(p.price)}</b></span>
      </button>`;
  }).join("") : '<p class="empty">Niemand gefunden.</p>');

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
  // Punkte-Ansicht braucht die Spielzeilen der neuen Aufstellung.
  if (state.tab === "points") await loadBreakdown();
  renderLeague();
}

async function loadMarket() {
  const res = await api(`/api/leagues/${state.leagueId}/market`);
  if (res.ok) state.market = res.data;
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
  if (!res.ok || !res.data.user) { state.user = null; return render(); }
  state.user = res.data.user;
  state.leagues = res.data.leagues || [];
  // Nur eine Liga? Dann direkt hinein, der Umweg über die Lobby nervt.
  if (!state.leagueId && state.leagues.length === 1) return openLeague(state.leagues[0].id);
  render();
}

function render() {
  whoEl.textContent = state.user ? state.user.name : "";
  if (!state.user) return renderAuth();
  if (!state.leagueId || !state.league) { tabsEl.hidden = true; return renderLobby(); }
  renderLeague();
}

// Wechselt der Nutzer den Reiter, muss das Nachgeladene stimmen.
tabsEl.addEventListener("click", () => {
  if (state.tab === "market" && !state.market) loadMarket().then(renderLeague);
  if (state.tab === "table" && !state.standings) loadStandings().then(renderLeague);
  if (state.tab === "points" && !state.breakdown) loadBreakdown().then(renderLeague);
});

loadMe();

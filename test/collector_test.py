"""
Prueft die ganze Kette: Sammler rechnet -> schickt an /api/ingest -> Worker
schreibt nach D1 -> App liefert es wieder aus.

Die Riot-API wird nachgebaut (aus dieser Umgebung ist sie gesperrt, und ein
Test soll ohnehin nicht vom Internet abhaengen). Alles danach ist echt: echter
Worker, echte Datenbank, echte HTTP-Aufrufe.
"""

import json
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "collector"))

BASE = os.environ.get("TEST_BASE", "http://127.0.0.1:8787")
TOKEN = os.environ.get("TEST_INGEST_TOKEN", "testtoken123")

os.environ["INGEST_URL"] = BASE
os.environ["INGEST_TOKEN"] = TOKEN
STATE = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
os.environ["FANTASY_STATE"] = STATE
# Schwelle senken, damit der Markt-Filter im Test ueberhaupt greift.
os.environ["FANTASY_MIN_TEAMS"] = "2"

import collect  # noqa: E402  (erst nach den Umgebungsvariablen importieren)

collect.STATE_PATH = STATE
collect.INGEST_URL = BASE
collect.INGEST_TOKEN = TOKEN
collect.time.sleep = lambda *_: None

fails = []


def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (f"  -> {extra}" if not cond and extra else ""))
    if not cond:
        fails.append(label)


# ---------------------------------------------------------------- Nachbau der API

NOW = datetime.now(timezone.utc)
LEAGUE_ID = "lec-id"
TEAMS = [("t-alpha", "ALP"), ("t-beta", "BET"), ("t-gamma", "GAM"),
         # Steht in getTeams, taucht aber in keinem Match auf - so wie die
         # laengst aufgeloesten Kader, die die echte API mitliefert.
         ("t-ghost", "GHO")]
ROLES = collect.ROLES

# Beide Matches muessen in der *laufenden* Runde liegen, sonst pruefen die
# Zusicherungen unten etwas anderes als gemeint: das fertige Match liefert die
# Punkte, das spaetere den Anpfiff fuer die Sperre.
ROUND_KEY, ROUND_START, ROUND_END = collect.round_bounds(NOW)
PAST = NOW - timedelta(days=1)
SOON = ROUND_END - timedelta(hours=1)
# Eine Woche zurueck, damit dieses Match keine Sperre in der laufenden Runde
# ausloest: es prueft nur, dass ein Bo1 ohne Formatangabe gewertet wird.
LAST_WEEK = NOW - timedelta(days=8)


def team_entry(tid, code, wins, outcome):
    return {"id": tid, "name": code + " Esports", "code": code,
            "result": {"gameWins": wins, "outcome": outcome}}


EVENTS = [
    {"startTime": collect.iso(PAST), "state": "completed",
     "blockName": "Woche 1", "league": {"name": "LEC"},
     "match": {"id": "m-past", "strategy": {"type": "bestOf", "count": 3},
               "games": [{"id": "g-1", "number": 1, "state": "completed"},
                         {"id": "g-2", "number": 2, "state": "completed"}],
               "teams": [team_entry("t-alpha", "ALP", 2, "win"),
                         team_entry("t-beta", "BET", 0, "loss")]}},
    # Gamma hat diese Runde noch nicht gespielt - nur mit so einem Team laesst
    # sich ueberhaupt noch ein Kader aufstellen.
    # Ohne Team-IDs, nur mit Kuerzel und Name - genau so liefert der echte
    # Spielplan viele Eintraege. Frueher verschwand dadurch jeder Anpfiff und
    # die Sperre war wirkungslos.
    {"startTime": collect.iso(SOON), "state": "unstarted",
     "blockName": "Woche 1", "league": {"name": "LEC"},
     "match": {"id": "m-soon", "strategy": {"type": "bestOf", "count": 3}, "games": [],
               "teams": [{"id": None, "name": "GAM Esports", "code": "GAM", "result": None},
                         {"id": None, "name": "BET Esports", "code": "BET", "result": None}]}},
    # Bo1 ohne "outcome" und ohne strategy.count - genau die Form, an der der
    # erste Produktivlauf jedes einzelne Match verworfen hat.
    {"startTime": collect.iso(LAST_WEEK), "state": "completed",
     "blockName": "Woche 0", "league": {"name": "LEC"},
     "match": {"id": "m-bo1", "strategy": {},
               "games": [{"id": "g-3", "number": 1, "state": "completed"}],
               "teams": [{"id": "t-gamma", "name": "GAM Esports", "code": "GAM",
                          "result": {"gameWins": 1}},
                         {"id": "t-beta", "name": "BET Esports", "code": "BET",
                          "result": {"gameWins": 0}}]}},
]

STATS = {
    "g-1": [("t-alpha", 4, 1, 6, 280), ("t-beta", 1, 4, 2, 240)],
    "g-2": [("t-alpha", 6, 0, 8, 310), ("t-beta", 2, 5, 3, 250)],
    "g-3": [("t-gamma", 3, 2, 5, 260), ("t-beta", 2, 3, 4, 250)],
}

# Wann welches Spiel wirklich lief. Spiel 2 der Serie faengt erst 45 Minuten
# nach dem Anpfiff des Matches an - genau deshalb reicht es nicht, einfach am
# Match-Anpfiff nachzufragen.
GAME_TIMES = {
    "g-1": (PAST, timedelta(minutes=32)),
    "g-2": (PAST + timedelta(minutes=45), timedelta(minutes=28)),
    "g-3": (LAST_WEEK, timedelta(minutes=30)),
}


def livestats_reply(gid, at):
    """Ein Fenster, wie der echte Feed es liefert.

    Ausserhalb der Spielzeit kommt *kein* leeres Ergebnis, sondern ein
    Platzhalter: zehn Teilnehmer auf Level 1, alles andere 0. Genau daran ist
    der erste Anlauf gescheitert - das sah nach einem echten Frame aus.
    Innerhalb der Spielzeit stehen die Werte anteilig zur gespielten Zeit, der
    Endstand also nur ganz am Schluss.
    """
    start, length = GAME_TIMES[gid]
    end = start + length
    meta, frames = {}, []
    pmeta_by_side = {}
    for side, (tid, k, d, a, cs) in zip(("blue", "red"), STATS[gid]):
        pmeta = [{"participantId": i, "esportsPlayerId": f"{tid}-{role}",
                  "summonerName": f"{tid}-{role}", "championId": "Ahri", "role": role}
                 for i, role in enumerate(ROLES, start=1)]
        meta[f"{side}TeamMetadata"] = {"esportsTeamId": tid, "participantMetadata": pmeta}
        pmeta_by_side[side] = (tid, k, d, a, cs)

    def snapshot(when):
        share = (when - start) / length
        frame = {"rfc460Timestamp": collect.iso(when),
                 "gameState": "in_game" if when < end else "finished"}
        for side, (_tid, k, d, a, cs) in pmeta_by_side.items():
            frame[f"{side}Team"] = {"participants": [
                {"participantId": i, "kills": round(k * share), "deaths": round(d * share),
                 "assists": round(a * share), "creepScore": round(cs * share),
                 "totalGold": 500 + round(11500 * share), "level": 1 + round(15 * share)}
                for i in range(1, len(ROLES) + 1)]}
        return frame

    if at is None:
        # Ohne startingTime kennt der Feed das Spiel nicht mehr.
        at = None
    if at is None or at < start or at > end:
        placeholder = {"rfc460Timestamp": collect.iso(NOW), "gameState": "finished"}
        for side in ("blue", "red"):
            placeholder[f"{side}Team"] = {"participants": [
                {"participantId": i, "kills": 0, "deaths": 0, "assists": 0,
                 "creepScore": 0, "totalGold": 0, "level": 1}
                for i in range(1, len(ROLES) + 1)]}
        return {"gameMetadata": meta, "frames": [placeholder]}

    # Zehn Frames im Abstand von zehn Sekunden, wie im echten Fenster.
    for step in range(10):
        when = min(at + timedelta(seconds=10 * step), end)
        frames.append(snapshot(when))
    return {"gameMetadata": meta, "frames": frames}


# Mitschrift aller Livestats-Abfragen, damit sich pruefen laesst, *wann*
# gefragt wurde - ein startingTime in der Zukunft quittiert die echte API
# naemlich mit 400.
PROBED = []


def fake_get(url, params=None, headers=None, tries=3):
    params = params or {}
    if "/livestats/" in url:
        gid = url.rsplit("/", 1)[-1]
        at = collect.parse_iso(params.get("startingTime"))
        PROBED.append(at)
        if gid not in STATS:
            return None
        return livestats_reply(gid, at)

    if url.endswith("/getLeagues"):
        return {"data": {"leagues": [{"id": LEAGUE_ID, "name": "LEC"}]}}
    if url.endswith("/getTeams"):
        return {"data": {"teams": [
            {"id": tid, "name": code + " Esports", "code": code, "image": "", "status": "active",
             "homeLeague": {"name": "LEC"},
             "players": [{"id": f"{tid}-{r}", "summonerName": f"{code}{r.title()}",
                          "firstName": "V", "lastName": "N", "role": r, "image": ""}
                         for r in ROLES]}
            for tid, code in TEAMS]}}
    if url.endswith("/getSchedule"):
        return {"data": {"schedule": {"events": EVENTS}}}
    if url.endswith("/getTournamentsForLeague"):
        return {"data": {"leagues": [{"tournaments": [
            {"id": "t1", "slug": "s", "startDate": f"{NOW.year}-01-05"}]}]}}
    if url.endswith("/getCompletedEvents"):
        return {"data": {"schedule": {"events": EVENTS}}}
    if url.endswith("/getEventDetails"):
        for ev in EVENTS:
            if ev["match"]["id"] == params.get("id"):
                return {"data": {"event": {"match": ev["match"]}}}
        return None
    raise AssertionError("unerwarteter Aufruf: " + url)


collect._get = fake_get

# ---------------------------------------------------------------- Lauf

print("\n== Sammler laeuft und schickt ==")
code = collect.main()
check("Sammler meldet Erfolg", code == 0, f"exit {code}")

with open(STATE, encoding="utf-8") as f:
    state = json.load(f)
check("Arbeitsstand enthaelt alle Spieler", len(state["players"]) == 20, len(state["players"]))
check("Geisterteam ist nicht mehr waehlbar",
      state["players"]["t-ghost-top"]["active"] is False, state["players"]["t-ghost-top"])
check("Spielende Teams bleiben waehlbar",
      state["players"]["t-alpha-top"]["active"] is True, state["players"]["t-alpha-top"])
check("Alle Spiele verarbeitet", sorted(state["processed"]) == ["g-1", "g-2", "g-3"], state["processed"])
# Bo1 ohne Formatangabe: frueher wurde so ein Match komplett verworfen.
bo1_round = collect.round_bounds(LAST_WEEK)[0]
check("Bo1 ohne Formatangabe wird gewertet",
      "t-gamma-top" in state["rounds"].get(bo1_round, {}).get("p", {}),
      list(state["rounds"].get(bo1_round, {}).get("p", {}))[:3])
check("Sieger des Bo1 bekommt den Serien-Bonus",
      any(l.get("wb") and l["p"].startswith("t-gamma") for l in state["lines"] if l["g"] == "g-3"),
      [l for l in state["lines"] if l["g"] == "g-3"][:2])
check("Verlierer des Bo1 bekommt ihn nicht",
      not any(l.get("wb") for l in state["lines"] if l["g"] == "g-3" and l["p"].startswith("t-beta")))
check("Anpfiffe fuer die Sperren gesammelt",
      len(state["fixtures"].get(ROUND_KEY, {})) == 3, state["fixtures"])
check("Team ohne ID wird ueber das Kuerzel aufgeloest",
      state["fixtures"][ROUND_KEY].get("t-gamma") == int(SOON.timestamp()),
      state["fixtures"].get(ROUND_KEY))
check("Frueheste Partie je Team zaehlt",
      state["fixtures"][ROUND_KEY]["t-beta"] == int(PAST.timestamp()),
      (state["fixtures"][ROUND_KEY].get("t-beta"), int(PAST.timestamp())))

# Punkte nachrechnen: alpha-top 4/1/6 280 -> 8+9-0.5+5.6 = 22.1
# zweites Spiel 6/0/8 310 -> 12+12+0+6.2 = 30.2, +2 kein Tod, +3 Serien-Sieg = 35.2
round_key = collect.round_bounds(PAST)[0]
alpha = state["rounds"][round_key]["p"]["t-alpha-top"]
check("Rundensumme stimmt", abs(alpha[0] - (22.1 + 35.2)) < 0.01, alpha)
check("Zwei Spiele gezaehlt", alpha[1] == 2, alpha)

# Die eigentliche Zusicherung gegen den Nullstand: die Werte in den Zeilen
# muessen die aus dem Spiel sein, nicht die aus den Frames danach.
g1 = next(l for l in state["lines"] if l["g"] == "g-1" and l["p"] == "t-alpha-top")
check("Spielwerte kommen aus dem Schlussstand, nicht aus den Frames danach",
      (g1["k"], g1["d"], g1["a"], g1["cs"]) == (4, 1, 6, 280), g1)
check("Keine einzige Zeile steht auf 0/0/0 mit 0 CS",
      not [l for l in state["lines"] if not (l["k"] or l["d"] or l["a"] or l["cs"])],
      [l for l in state["lines"] if not (l["k"] or l["d"] or l["a"] or l["cs"])][:2])

print("\n== Frames auswaehlen ==")
real = {"blueTeam": {"participants": [{"kills": 3, "deaths": 1, "assists": 2,
                                       "creepScore": 200, "totalGold": 9000}]},
        "redTeam": {"participants": []}}
null = {"blueTeam": {"participants": [{"kills": 0, "deaths": 0, "assists": 0,
                                       "creepScore": 0, "totalGold": 0}]},
        "redTeam": {"participants": []}}
check("Leerer Frame zaehlt als leer", collect.frame_activity(null) == 0)
check("Frame mit Werten zaehlt als voll", collect.frame_activity(real) > 0)
check("Nachlaufende Leerframes werden uebersprungen",
      collect.last_real_frame([real, null, null]) is real)
check("Nur Leerframes ergeben keinen Frame",
      collect.last_real_frame([null, null]) is None)
check("Ohne Frames auch keiner", collect.last_real_frame([]) is None)
# Startgold zaehlt mit: in der ersten Minute gibt es noch keine Kills und
# keinen Creep Score, der Frame ist aber trotzdem echt.
kickoff = {"blueTeam": {"participants": [{"kills": 0, "deaths": 0, "assists": 0,
                                          "creepScore": 0, "totalGold": 500, "level": 1}]},
           "redTeam": {"participants": []}}
check("Anpfiff-Frame gilt als echt", collect.last_real_frame([kickoff]) is kickoff)
# Der Platzhalter, den der Feed ausserhalb der Spielzeit liefert: Level 1,
# sonst alles 0. Zaehlte Level mit, saehe er wie ein echter Frame aus - genau
# daran ist der erste Anlauf gescheitert.
placeholder = {"blueTeam": {"participants": [
    {"kills": 0, "deaths": 0, "assists": 0, "creepScore": 0, "totalGold": 0, "level": 1}
    for _ in range(5)]}, "redTeam": {"participants": []}}
check("Platzhalter ausserhalb der Spielzeit gilt nicht als Frame",
      collect.frame_activity(placeholder) == 0, collect.frame_activity(placeholder))
check("Und ergibt deshalb auch keinen Frame",
      collect.last_real_frame([placeholder]) is None)

print("\n== Spielzeit im Feed finden ==")
# Ohne startingTime kennt der Feed ein beendetes Spiel nicht mehr. Der Sammler
# muss die Spielzeit selbst finden - und zwar bis ans Ende, sonst friert der
# Stand mitten im Spiel ein.
budget = {}
win, used = collect.find_final_window("g-1", PAST, budget)
check("Fenster mit dem Schlussstand gefunden", win is not None)
if win:
    last = collect.last_real_frame(win["frames"])
    p = last["blueTeam"]["participants"][0]
    check("Und zwar der Schlussstand, nicht ein Zwischenstand",
          (p["kills"], p["deaths"], p["assists"], p["creepScore"]) == (4, 1, 6, 280), p)
check("Die Suche kostet Anfragen, aber nicht beliebig viele", 0 < used <= 30, used)
check("Das Budget wird mitgezaehlt", budget["walks"] == used, budget)

# Spiel 2 der Serie laeuft erst 45 Minuten nach dem angesetzten Anpfiff - am
# Match-Anpfiff allein wuerde man es nicht finden.
win2, _ = collect.find_final_window("g-2", PAST, {})
check("Auch das zweite Spiel einer Serie wird gefunden", win2 is not None)
if win2:
    p2 = collect.last_real_frame(win2["frames"])["blueTeam"]["participants"][0]
    check("Mit seinem eigenen Schlussstand",
          (p2["kills"], p2["deaths"], p2["assists"], p2["creepScore"]) == (6, 0, 8, 310), p2)

# Ist das Budget aufgebraucht, hoert die Suche auf, statt den Lauf zu sprengen.
erschoepft = {"walks": collect.LIVESTATS_WALK_BUDGET}
win3, used3 = collect.find_final_window("g-1", PAST, erschoepft)
check("Bei aufgebrauchtem Budget wird nicht weitergesucht",
      win3 is None and used3 == 0, (win3 is not None, used3))

# Bei einem Spiel von vorhin liegt "Anpfiff plus vier Stunden" in der Zukunft.
# Danach zu fragen beantwortet die echte API mit 400 - im Produktivlauf ist so
# genau ein Spiel verlorengegangen.
PROBED.clear()
collect.find_final_window("g-1", NOW - timedelta(minutes=20), {})
zukunft = [t for t in PROBED if t and t > NOW]
check("Es wird nie in die Zukunft gefragt", not zukunft, [str(t) for t in zukunft[:2]])

# Ein Spiel, das der Feed gar nicht kennt, darf nicht gespeichert werden -
# lieber beim naechsten Lauf nochmal fragen als Nullen in die App.
check("Ein Spiel ganz ohne Werte wird nicht gespeichert",
      collect.read_game("g-1", {}, {}, None, PAST - timedelta(days=400)) is None)

# ---------------------------------------------------------------- Ankunft pruefen

print("\n== In der App angekommen ==")
s = requests.Session()
suffix = str(random.randint(10000, 99999))
r = s.post(f"{BASE}/api/register", json={"name": "Sammler" + suffix, "password": "geheim12345"})
check("Testkonto angelegt", r.status_code == 201, r.text[:200])
r = s.post(f"{BASE}/api/leagues", json={"name": "Sammlertest " + suffix})
league_id = r.json()["league"]["id"]

market = s.get(f"{BASE}/api/leagues/{league_id}/market").json()
by_id = {p["id"]: p for p in market["players"]}
check("Nur spielende Teams stehen im Markt", len(market["players"]) == 15, len(market["players"]))
check("Geisterspieler fehlt im Markt", "t-ghost-top" not in by_id, list(by_id)[:3])
check("Rolle wurde uebernommen", by_id["t-alpha-top"]["role"] == "top", by_id.get("t-alpha-top"))
check("Team wurde uebernommen", by_id["t-alpha-top"]["code"] == "ALP", by_id.get("t-alpha-top"))
check("Preis liegt im Rahmen",
      collect.PRICE_MIN <= by_id["t-alpha-top"]["price"] <= collect.PRICE_MAX,
      by_id["t-alpha-top"]["price"])
check("Saisonschnitt kam mit", by_id["t-alpha-top"]["avg"] > 0, by_id["t-alpha-top"])

current_key = collect.round_bounds(NOW)[0]
if current_key == round_key:
    check("Rundenpunkte des Sammlers stehen im Markt",
          abs(by_id["t-alpha-top"]["roundPts"] - state["rounds"][round_key]["p"]["t-alpha-top"][0]) < 0.15,
          (by_id["t-alpha-top"]["roundPts"], state["rounds"][round_key]["p"]["t-alpha-top"]))

    # Die Anpfiffe sind angekommen, wenn daraus die richtige Sperre folgt.
    r = s.put(f"{BASE}/api/leagues/{league_id}/squad",
              json={"role": "top", "playerId": "t-alpha-top"})
    check("Team, das schon gespielt hat, ist gesperrt", r.status_code == 409, r.text[:160])
    r = s.put(f"{BASE}/api/leagues/{league_id}/squad",
              json={"role": "top", "playerId": "t-gamma-top"})
    check("Team, das erst spaeter spielt, ist waehlbar", r.status_code == 200, r.text[:160])
    if SOON > NOW:
        check("Anpfiff steht im Kader",
              r.json()["me"]["slots"]["top"]["kickoff"] is not None, r.json()["me"]["slots"]["top"])
else:
    print("  (Match liegt in der Vorrunde - Punkte- und Sperrpruefung uebersprungen)")

# Spielzeilen landen in der Datenbank, auch wenn sie erst mit einem passenden
# Kader sichtbar werden - deshalb direkt nachzaehlen.
import subprocess
out = subprocess.run(
    ["npx", "wrangler", "d1", "execute", "fantasy-lol", "--local", "--json",
     "--command", "SELECT COUNT(*) AS n FROM lines WHERE game_id LIKE 'g-%'"],
    capture_output=True, text=True, cwd=os.path.join(os.path.dirname(__file__), ".."),
    env=dict(os.environ, WRANGLER_SEND_METRICS="false", CI="1"))
try:
    payload = json.loads(out.stdout[out.stdout.index("["):])
    count = payload[0]["results"][0]["n"]
except Exception as e:
    count = f"nicht lesbar ({e}): {out.stdout[-200:]}"
check("Alle Spielzeilen stehen in der Datenbank", count == 30, count)

print("\n== Zweiter Lauf aendert nichts ==")
# Der geschriebene Arbeitsstand muss beim naechsten Lauf auch angenommen
# werden. Fehlt darin eine der beiden Versionsangaben, haelt load_data() ihn
# fuer veraltet und baut jedes Mal neu auf - das faellt sonst nirgends auf,
# weil das Ergebnis ja stimmt. Nur bleibt der Sammler dann fuer immer bei
# MAX_NEW_GAMES Spielen stehen und fragt alle drei Stunden die ganze Saison
# neu ab.
saved = json.load(open(STATE, encoding="utf-8"))
check("Arbeitsstand nennt beide Versionen",
      saved.get("scoringVersion") == collect.SCORING_VERSION
      and saved.get("dataVersion") == collect.DATA_VERSION,
      (saved.get("scoringVersion"), saved.get("dataVersion")))
reloaded = collect.load_data()
check("Und wird beim naechsten Lauf wiederverwendet",
      sorted(reloaded["processed"]) == ["g-1", "g-2", "g-3"], reloaded["processed"][:5])

before = saved["rounds"][round_key]["p"]["t-alpha-top"]
collect.main()
after = json.load(open(STATE, encoding="utf-8"))["rounds"][round_key]["p"]["t-alpha-top"]
check("Punkte bleiben gleich (keine Doppelzaehlung)", before == after, (before, after))

os.unlink(STATE)
print("\n" + ("ALLE SAMMLER-TESTS BESTANDEN" if not fails else f"{len(fails)} FEHLER: {fails}"))
sys.exit(1 if fails else 0)

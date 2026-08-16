# Fantasy LoL

Fantasy-Liga für LoL-Esports: Du stellst einen Kader aus echten Profispielern
zusammen und bekommst Punkte für das, was sie in LEC, LCS, LCK und LPL wirklich
abliefern. Eigene Konten, eigene Ligen, Beitritt per Einladungscode.

Läuft komplett auf Cloudflare (ein Worker, eine D1-Datenbank) und kostet im
Rahmen der kostenlosen Kontingente nichts. Die Spielwerte holt ein Python-Skript,
das als GitHub Action alle drei Stunden läuft.

---

## Spielregeln

| | |
| --- | --- |
| Kader | genau ein Top, Jungle, Mid, Bot und Support |
| Budget | 35.0 - Preise liegen zwischen 4.0 und 12.0 |
| Runde | Montag 12:00 bis Montag 12:00 (Europe/Berlin) |
| Kapitän | einer pro Runde, zählt doppelt |
| Sperre | ein Platz ist fest, sobald das Team des Spielers sein erstes Spiel der Runde begonnen hat |
| Wechsel | jederzeit, solange der Platz nicht gesperrt ist |

Drei Regeln, die den Rest erklären:

- **Gesperrt wird pro Platz, nicht pro Runde.** Spielt LEC erst am Samstag,
  kannst du deinen LEC-Spieler bis Samstag tauschen - auch wenn dein
  LCK-Spieler schon Mittwoch dran war. Das belohnt Planung, statt alles auf
  den Rundenwechsel zu legen.
- **Der Kader läuft weiter, bis du ihn änderst.** Wer eine Woche nicht
  reinschaut, spielt trotzdem mit. Sonst hinge alles daran, die Seite
  rechtzeitig zu öffnen.
- **Bezahlt wird der Preis vom Zeitpunkt der Wahl.** Steigt ein Spieler später
  im Wert, bleibt dein Kader gültig; du musst ihn nicht verkaufen. Erst beim
  nächsten Tausch zählt der neue Preis.

Fremde Kader sind verdeckt, bis der eigene vollständig steht - sonst schreibt
man einfach ab. Die Punktzahl der anderen sieht man trotzdem; die verrät keine
Aufstellung und macht den Wettkampf erst spannend.

Der eigene Kader steht auf der Kluft der Beschwörer: drei Lanes, der Fluss
quer hindurch, die Waldstücke dazwischen, der rote Nexus unten links und der
blaue oben rechts. Jeder Platz liegt dort, wo die Rolle wirklich spielt - Top
oben links, der Jungler zwischen den Lanes, Mid in der Mitte, Botlane unten
rechts. Antippen wählt den Spieler für diese Position.

Die Karte ist selbst gezeichnet (ein SVG in `riftMapSvg()`), nicht Riots
Artwork: ein Bild müsste nachgeladen werden, wäre nicht meins und ließe sich
nicht mit den Farben der Seite einfärben. Ein SVG kostet nichts und bleibt bei
jeder Größe scharf. Dasselbe gilt für die fünf Rollenzeichen im Sprite ganz
oben in `index.html`.

### Spielerkarten

Jeder Spieler ist eine Sammelkarte, in drei Größen und immer aus derselben
Funktion (`cardHtml`): klein auf der Kluft, mittel im Markt und im
Auswahlfenster. Vier Zonen von oben nach unten - Ligawappen und Vereinswappen,
Gesicht, Name mit Rollenzeichen, und unten die zwei Zahlen, um die es beim
Aufstellen geht: was er kostet und was er bringt.

**Jede Mannschaft trägt einen eigenen Farbton**, gerechnet aus ihrem Kürzel
(`teamHue`). Vereinsfarben liefert die API nicht, und eine Liste von Hand
veraltet mit jedem Kaderwechsel. Der Zweck ist ohnehin ein anderer als
Markentreue: fünf Farben im Kader heißt fünf Vereine, zwei gleiche heißt zwei
Spieler, die am selben Tag gesperrt sind. Echte Vereinsfarben täten das nicht -
die halbe LEC spielt in Rot.

Zustände haben je eine eigene *Form*, nicht nur eine andere Farbe, weil Farbe
allein bei Sonne auf dem Handy untergeht: Kapitän goldenes Siegel und
„Punkte ×2", im Kader goldener Rand und Band, gesperrt entsättigt mit
Schraffur, frei gestrichelt mit dem Rollenzeichen.

Zwei Klassennamen sind hier heikel und deshalb bewusst getrennt: `.card` ist
die Fläche einer Seitensektion, `.pcard` die Spielerkarte. Beide `.card` zu
nennen hat im Bau jede Sektion der App zu einer 3:4-Karte gemacht.

Unter der Karte steht, **wann und gegen wen** jeder deiner Spieler antritt -
auf den Marken selbst wäre dafür kein Platz, und untereinander liest man die
Woche auf einen Blick: welcher Platz läuft schon, welchen kannst du noch
tauschen.

Im *Markt* liegt eine sortierbare Tabelle mit Preis, Saisonpunkten, Schnitt
und der Spalte **Gewählt**: wie viele in deiner Liga diesen Spieler schon
haben. Die ist der interessanteste Wert der Seite - sie zeigt, wo alle
hinlaufen und wo noch etwas zu holen ist.

Unter jedem Namen steht außerdem ein Balken, **wodurch** die Punkte zustande
kommen: Kills, Assists, Creep Score, Siege. „Ø 18.4" sagt nur, dass jemand gut
ist; der Balken sagt warum. Ein Support, der von Assists lebt, sieht anders aus
als ein Botlaner mit Kills - und wer seine Punkte vor allem aus Creep Score
zieht, ist verlässlich statt spektakulär. Die Zahlen darunter sind der Schnitt
je Spiel.

### Punkte

Pro Spiel eines Spielers:

| Wert | Punkte |
| --- | --- |
| Kill | +2 |
| Assist | +1,5 |
| Tod | −0,5 |
| Creep Score | +0,02 je Creep |
| 10 Kills **oder** 10 Assists in einem Spiel | +2 |
| kein einziger Tod | +2 |
| Team gewinnt die Serie | +3, einmal je Match |

Der Sieg-Bonus hängt am Match und nicht am einzelnen Spiel, weil die API nur
den Sieger der Serie meldet - wer ein einzelnes Spiel gewonnen hat, steht
nirgends. Angezeigt wird er beim letzten Spiel des Spielers in diesem Match.

Unter *Punkte* steht jedes Spiel einzeln, und ein Tipp darauf klappt den
Rechenweg auf: „Kills 5 × +2 → +10,0", „Tode 1 × −0,5 → −0,5" und so weiter
bis zur Summe. Die Formel dafür liefert der Server - der Sammler schickt sie
beim Abschluss eines Laufs mit -, damit Anzeige und Wertung nicht
auseinanderlaufen. Passt die aufgeklappte Summe trotzdem nicht zum gewerteten
Wert, steht das dabei: dann wurde das Spiel nach einer älteren Formel
gerechnet und behält seine Punkte.

### Preise

Der Preis ergibt sich aus dem Punkteschnitt der letzten zehn Runden, in denen
ein Spieler gespielt hat - **innerhalb seiner Rolle** nach Rang verteilt. Der
beste Support kostet genauso viel wie der beste Midlaner. Das ist Absicht: weil
jede Rolle genau einmal besetzt werden muss, gäbe eine rollenübergreifende
Skala nur fünf teure Midlaner und lauter billige Supports her.

Preise frieren zum Rundenwechsel ein, damit sich ein längst gesetzter Kader
nicht mitten in der Woche verteuert. Wer weniger als drei Spiele im
Bewertungsfenster hat, steht auf dem Einheitspreis 5.0.

---

## Einrichten

Gebraucht werden ein Cloudflare-Konto (kostenlos) und dieses Repo.

```bash
npm install
npx wrangler login
```

**1. Datenbank anlegen** und die ausgegebene `database_id` in `wrangler.toml`
eintragen:

```bash
npx wrangler d1 create fantasy-lol
```

**2. Tabellen anlegen** (auch nach jedem `git pull`, der neue Dateien in
`migrations/` bringt - sonst schlägt die Aufnahme der Statistikdaten mit
"no such column" fehl, bis das Schema stimmt):

```bash
npm run db:remote     # legt das Schema in der echten Datenbank an
```

Das nutzt Wranglers Migrationssystem: es merkt sich, welche Dateien aus
`migrations/` schon gelaufen sind, und wendet nur neue an. Nach einem `git pull`
mit neuen Migrationen einfach nochmal aufrufen.

**3. Token für den Sammler setzen.** Damit weist sich die GitHub Action bei
`/api/ingest` aus - ohne das Token kommt niemand an die Statistikdaten:

```bash
openssl rand -hex 32          # Ausgabe merken
npx wrangler secret put INGEST_TOKEN
```

Unter Windows ohne openssl tut es auch die PowerShell:

```powershell
powershell -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')"
```

**4. Deployen:**

```bash
npm run deploy
```

Die App liegt danach unter `https://fantasy-lol.<dein-subdomain>.workers.dev`.

**5. GitHub Action einrichten.** Unter *Settings → Secrets and variables →
Actions* zwei Secrets anlegen:

| Secret | Wert |
| --- | --- |
| `INGEST_URL` | die Worker-URL aus Schritt 4, ohne Schrägstrich am Ende |
| `INGEST_TOKEN` | dasselbe Token wie in Schritt 3 |

Dann unter *Actions → Statistiken sammeln → Run workflow* einmal von Hand
starten. Der erste Lauf holt höchstens 250 Spiele; nach ein paar Durchgängen
ist die laufende Saison vollständig. Danach läuft es alle drei Stunden von
selbst.

**6. Loslegen.** Seite aufrufen, Konto anlegen, Liga gründen, den
Einladungscode an die Mitspieler schicken.

---

## Entwickeln

```bash
npm run db:local      # Schema in die lokale Datenbank
npm run dev           # Worker samt Frontend auf http://localhost:8787
npm test              # alle Tests gegen eine frische lokale Umgebung
```

`npm test` setzt die lokale Datenbank zurück, startet den Worker und lässt
nacheinander laufen:

| Suite | Was sie prüft |
| --- | --- |
| `test/api.test.mjs` | Konten, Ligen, Budget, Sperren, Wertung, Verdeckt-Regel - gegen echte D1 |
| `test/ui.test.mjs` | zwei echte Browser-Nutzer durch die ganze App (Playwright) |
| `test/collector_test.py` | Sammler rechnet → schickt → Worker schreibt → App liefert aus |

Die Riot-API wird in den Tests nachgebaut. Das ist Absicht: Tests sollen nicht
davon abhängen, ob gerade ein Spiel läuft.

Sammler lokal ausprobieren, ohne etwas zu verschicken:

```bash
python collector/collect.py --dry-run
```

---

## Wie es aufgebaut ist

```
src/index.js       Router: /api/* zuerst, dann die statischen Dateien
src/auth.js        Konten, Passwörter (PBKDF2), Sitzungen
src/game.js        Ligen, Kader, Sperren, Budget, Punkte, Tabelle
src/ingest.js      Aufnahme der Statistikdaten (nur mit INGEST_TOKEN)
public/            Frontend: eine HTML-Datei, ein Stylesheet, ein Skript
migrations/        Datenbankschema
collector/         Python-Sammler + sein Arbeitsstand (state.json)
```

**Die Oberfläche teilt sich die Gestaltungssprache mit lolkleena.** Farben,
Materialstärken, Schatten und die Federkurven in `public/style.css` sind
dieselben Werte wie dort - beide Seiten sollen sich wie ein Haus anfühlen.
Grundlage ist `apple-design`: Flächen sind Material mit Dicke statt Rechtecke
mit Rand, Bewegung kommt aus ausgerechneten Federn statt geratenen Kurven, und
Laufweite und Zeilenhöhe gehören zur Schriftgröße. Am Telefon steht die
Navigation unten am Daumen, ab 760px als Leiste links wie auf lolkleena.

**Alles, was über Punkte entscheidet, rechnet der Server.** Der Client schickt
„setze Mid auf Spieler X" - Preis, Budget, Sperre und Wertung bestimmt der
Worker. Sonst könnte jeder mit der Entwicklerkonsole seinen Kader nachträglich
umbauen. Das Frontend hat bewusst keinen zweiten Rechenweg, der vom Server
abweichen könnte.

**Die Datenbank hat zwei Hälften.** Spielbetrieb (`users`, `leagues`,
`members`, `squads`) schreibt die App; Statistik (`players`, `rounds`,
`player_round`, `prices`, `lines`, `fixtures`) schreibt ausschließlich der
Sammler. Ein Neuaufbau der Statistik löscht deshalb nie einen Kader.

**Ein Kader wird pro Runde gespeichert.** Fehlt für eine Runde ein Eintrag,
gilt der letzte davor. Ändert jemand etwas, wird der geerbte Kader zuerst in
die laufende Runde kopiert und dann geändert - sonst stünde dort nur ein
einzelner Platz und der Rest wäre weg.

### Woher die Werte kommen

- **Kader und Rollen:** `getTeams` der Riot-Esports-API. Dort stehen auch
  längst aufgelöste Kader, viele ohne `status`-Feld - wählbar sind deshalb nur
  Spieler von Teams, die in dieser Saison tatsächlich gespielt haben oder
  angesetzt sind. Ihre Punkte behalten alle anderen, sie tauchen nur nicht mehr
  im Markt auf.
- **Spielwerte:** der Livestats-Feed
  (`feed.lolesports.com/livestats/v1/window/<gameId>`). Der teuerste Irrtum
  bisher, deshalb ausführlich:

  **Der Feed kennt keinen „gib mir den Endstand".** Ruft man ihn ohne
  `startingTime` auf, antwortet er für ein beendetes Spiel mit einem
  Platzhalter: zehn Teilnehmer auf Level 1, alles andere 0. Wer den nimmt,
  schreibt lauter Nullen in die Datenbank - und weil „kein Tod" als
  makelloses Spiel gilt, bekommt jeder Spieler dafür auch noch +2. Genau so
  stand in der App wochenlang überall `0/0/0 · 0 CS · 2.0`.

  Der Sammler sucht die Spielzeit deshalb selbst (`find_final_window`):

  1. Ein Schuss vier Stunden hinter den Anpfiff. Der Feed fällt dort auf den
     letzten vorhandenen Stand zurück - im Produktivlauf reichte das für
     jedes einzelne Spiel, also eine Anfrage pro Spiel.
  2. Falls nicht: grob in Zehn-Minuten-Schritten vom angesetzten Anpfiff nach
     vorn, bis nach einem Fenster mit Werten eines ohne kommt. Dazwischen
     endete das Spiel. Die vier Stunden Reichweite sind nötig, weil Spiel 2
     und 3 einer Serie lange nach dem Anpfiff des Matches laufen.
  3. Dann in diesem Zehn-Minuten-Loch halbieren, sonst friert der Stand
     Minuten vor dem Ende ein.

  Schritt 2 und 3 sind das Netz, nicht der Regelweg — dass Schritt 1
  funktioniert, ist eine Beobachtung und keine Zusage von Riot.

  Level zählt bei der Frage „ist das ein echter Frame?" bewusst **nicht** mit -
  sonst sieht der Platzhalter wie ein Spielstand aus. Gold schon, denn beim
  Anpfiff hat jeder 500. Ergibt ein Spiel am Ende überall Nullen, wird es
  **nicht** gespeichert; lieber im nächsten Lauf nochmal fragen. Die Suche hat
  ein Anfragebudget je Lauf (`FANTASY_MAX_WALKS`), damit ein Neuaufbau die
  Action nicht ins Zeitlimit treibt - was nicht mehr reinpasst, holt der
  nächste Durchgang.
- **Welche Matches:** `getSchedule` plus `getCompletedEvents` je Turnier der
  laufenden Saison.
- **Wappen:** Vereinswappen aus `getTeams`, Ligawappen aus `getLeagues`. Die
  Ligawappen stehen in einer eigenen Tabelle `esport_leagues` - **nicht**
  `leagues`, denn so heißen schon die Fantasy-Ligen der Nutzer. Ein
  `CREATE TABLE IF NOT EXISTS leagues` wäre stillschweigend wirkungslos
  geblieben und erst beim Einspielen mit „no such column" aufgefallen.
- **Anpfiffe und Gegner:** `getSchedule`, erster Anpfiff jedes Teams in
  der laufenden und der kommenden Runde. Der Gegner steht im selben Eintrag und
  kostet keine zusätzliche Anfrage. Achtung: der Spielplan liefert für
  viele Einträge `"id": null` bei den Teams. Name und Kürzel stehen aber drin,
  darüber wird die Team-ID aus `getTeams` nachgeschlagen - ohne das verschwindet
  jeder Anpfiff und die Sperre greift nie.

Genutzt wird dieselbe öffentliche API, die lolesports.com im Browser aufruft -
kein Schlüssel nötig, aber auch keine Zusage von Riot, dass sie so bleibt.
Bleibt der Sammler leer, zuerst in die Action-Logs schauen.

Jeder Lauf schreibt zwei Zeilen ins Log, die genau dafür da sind, dass so ein
Fehler nicht wieder wochenlang unbemerkt bleibt:

```
Beispiel g-1: 3 Frames, genutzt Nr. 1 (Stand 2026-08-15T18:30:00Z, 122850 Punkte Aktivität)
Schnitt je Spielzeile: 3.0/2.5/4.7, 265 CS, 18.4 Punkte  (30 Zeilen)
```

Steht im Schnitt `0.0/0.0/0.0, 0 CS`, wird der Feed falsch gelesen. Vorher
stand im Log nur, wie viele Spiele verarbeitet wurden - und das stimmte ja.

Der Sammler arbeitet inkrementell und merkt sich verarbeitete Matches in
`collector/state.json`. Ein Match wird immer komplett verarbeitet oder gar
nicht - sonst gäbe es den Serien-Bonus doppelt. Fehlen Livestats, versucht er
es dreimal und hakt das Match dann ab.

### Punktesystem ändern

Werte in `collector/collect.py` unter `SCORING` anpassen **und
`SCORING_VERSION` erhöhen**. Der nächste Lauf rechnet die Saison dann von vorn
durch, statt alte und neue Punkte zu mischen. Komplett neu aufbauen:

```bash
FANTASY_REBUILD=1 python collector/collect.py
```

Ändert sich dagegen, **wie** die Werte aus der API gelesen werden, gehört
`DATA_VERSION` hoch. Wirkt genauso - der nächste Lauf holt die Saison neu -,
sagt aber ehrlich, was der Grund war.

### Andere Ligen

`FANTASY_LEAGUES` in `collector/collect.py` anpassen. Möglich sind alle Namen,
die `getLeagues` liefert - z.B. `LEC`, `LCS`, `LCK`, `LPL`, `MSI`, `Worlds`,
`EMEA Masters`. Mehr Ligen heißt mehr Spiele pro Lauf; notfalls
`FANTASY_MAX_GAMES` hochsetzen.

---

## Grenzen, die man kennen sollte

- **Per-Spiel-Sieger gibt es nicht.** Siehe Sieg-Bonus oben. Sollte Riots
  offizielles Daten-Portal das liefern, ist der Umbau klein: die Statistikquelle
  steckt komplett in `read_game()` in `collector/collect.py`.
- **Die Sperre hängt am Spielplan.** Verschiebt Riot ein Spiel kurzfristig,
  greift die neue Sperre erst nach dem nächsten Sammellauf (maximal drei
  Stunden später).
- **Passwörter** liegen als PBKDF2-Hash (100.000 Runden, eigenes Salt) in der
  Datenbank. Mehr lässt die Workers-Runtime nicht zu: oberhalb von 100.000
  verweigert sie die Berechnung. Für eine Freundesrunde ist das solide, solange
  die Passwörter selbst etwas taugen. Eine Passwort-vergessen-Funktion gibt es
  bewusst nicht - dafür bräuchte es E-Mail-Versand.

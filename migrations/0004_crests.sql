-- Wappen und bürgerlicher Name für die Spielerkarten.
--
-- Beides liest der Sammler längst aus `getTeams`, er hat es nur nie
-- mitgeschickt. Das Vereinswappen trägt die Karte optisch, der bürgerliche
-- Name steht als zweite Zeile unter dem Spielernamen.

ALTER TABLE players ADD COLUMN team_image TEXT;
ALTER TABLE players ADD COLUMN full_name  TEXT;

-- Die Ligawappen bekommen eine eigene kleine Tabelle statt einer Spalte bei
-- jedem Spieler: es gibt vier Ligen und dreihundert Spieler, und so lässt
-- sich das Wappen auch neben den Ligafiltern zeigen.
--
-- Sie heißt bewusst NICHT `leagues`. Dieses Wort ist hier doppelt belegt:
-- `leagues` sind die Fantasy-Ligen der Nutzer ("Kleena-Liga"), gemeint sind
-- hier aber LEC, LCS, LCK und LPL. Ein `CREATE TABLE IF NOT EXISTS leagues`
-- wäre stillschweigend wirkungslos geblieben, und das Einspielen der Wappen
-- wäre erst in der Produktion mit "no such column: image" gescheitert.
CREATE TABLE IF NOT EXISTS esport_leagues (
  name  TEXT PRIMARY KEY,
  image TEXT
);

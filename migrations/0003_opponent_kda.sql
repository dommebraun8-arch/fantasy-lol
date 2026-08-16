-- Zwei Dinge, die bisher fehlten:
--
-- 1. Der Gegner. Bisher stand in fixtures nur, *wann* ein Team spielt - für
--    die Sperre reicht das, für die Anzeige nicht. "Sa 17:00" sagt weniger
--    als "Sa 17:00 gegen G2".
-- 2. Woher die Punkte eines Spielers kommen. season_pts allein sagt nur, dass
--    er gut war, nicht warum. Kills, Tode, Assists, Creep Score und Siege
--    getrennt zu führen macht den Markt lesbar - und kostet nichts, der
--    Sammler kennt die Zahlen ohnehin.
--
-- Die Summen stehen bei den Spielern und nicht in `lines`, weil Spielzeilen
-- nach 35 Tagen weggeräumt werden, die Saisonwertung aber nicht.

ALTER TABLE players ADD COLUMN season_k    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN season_d    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN season_a    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN season_cs   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN season_wins INTEGER NOT NULL DEFAULT 0;

ALTER TABLE fixtures ADD COLUMN opponent    TEXT;
ALTER TABLE fixtures ADD COLUMN opponent_id TEXT;

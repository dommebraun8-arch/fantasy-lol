-- Rundenzahl des Passwort-Hashes je Konto mitschreiben.
--
-- Ohne sie waere jede spaetere Aenderung des Standards eine Aussperrung: der
-- gespeicherte Hash liesse sich nicht mehr reproduzieren. So bleibt jedes Konto
-- mit den Runden pruefbar, mit denen es angelegt wurde.
ALTER TABLE users ADD COLUMN pw_rounds INTEGER NOT NULL DEFAULT 100000;

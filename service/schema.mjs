/**
 * The database schema, as an ordered list of migrations. `PRAGMA user_version`
 * records how many have run. Append a migration; never edit one that has
 * shipped, since a database out there has already run it.
 *
 * Items keep an internal integer id. The ID people see (TC-123) is the
 * portfolio's key plus the item's number, so renaming a key renames every ID
 * at once and moving a task between projects changes nothing.
 *
 * SQLite reads a double-quoted string as an identifier, so every literal here
 * is single-quoted.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE portfolios (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT;

  CREATE TABLE statuses (
    id           INTEGER PRIMARY KEY,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    grp          TEXT NOT NULL CHECK (grp IN ('not-started', 'active', 'done', 'closed')),
    colour       TEXT NOT NULL,
    icon         TEXT NOT NULL,
    position     REAL NOT NULL,
    is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
  ) STRICT;
  CREATE UNIQUE INDEX statuses_name ON statuses (portfolio_id, name COLLATE NOCASE);
  CREATE UNIQUE INDEX statuses_default ON statuses (portfolio_id) WHERE is_default = 1;

  CREATE TABLE priorities (
    id           INTEGER PRIMARY KEY,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     REAL NOT NULL,
    is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
  ) STRICT;
  CREATE UNIQUE INDEX priorities_name ON priorities (portfolio_id, name COLLATE NOCASE);
  CREATE UNIQUE INDEX priorities_default ON priorities (portfolio_id) WHERE is_default = 1;

  CREATE TABLE projects (
    id           INTEGER PRIMARY KEY,
    portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    colour       TEXT NOT NULL,
    position     REAL NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX projects_name ON projects (portfolio_id, name COLLATE NOCASE);

  -- norm is the comparison form (folders.mjs). One folder belongs to one
  -- project, so resolving a working directory is never ambiguous.
  CREATE TABLE project_folders (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    norm       TEXT NOT NULL UNIQUE,
    position   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX project_folders_project ON project_folders (project_id);

  CREATE TABLE items (
    id                INTEGER PRIMARY KEY,
    portfolio_id      INTEGER NOT NULL REFERENCES portfolios(id),
    number            INTEGER NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('epic', 'task')),
    project_id        INTEGER NOT NULL REFERENCES projects(id),
    epic_id           INTEGER REFERENCES items(id) ON DELETE SET NULL,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    status_id         INTEGER NOT NULL REFERENCES statuses(id),
    priority_id       INTEGER NOT NULL REFERENCES priorities(id),
    position          REAL NOT NULL,
    handoff_done      TEXT,
    handoff_left      TEXT,
    handoff_next      TEXT,
    handoff_by        TEXT,
    handoff_at        TEXT,
    session_id        TEXT,
    session_name      TEXT,
    session_active_at TEXT,
    created_by        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (portfolio_id, number),
    CHECK (kind = 'task' OR epic_id IS NULL)
  ) STRICT;
  CREATE INDEX items_project ON items (project_id);
  CREATE INDEX items_epic ON items (epic_id);
  CREATE INDEX items_status ON items (status_id);
  CREATE INDEX items_priority ON items (priority_id);

  CREATE TABLE criteria (
    id       INTEGER PRIMARY KEY,
    item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    text     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
  ) STRICT;
  CREATE INDEX criteria_item ON criteria (item_id, position);

  -- item_id waits on waits_on_id.
  CREATE TABLE dependencies (
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    waits_on_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, waits_on_id),
    CHECK (item_id <> waits_on_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX dependencies_waits_on ON dependencies (waits_on_id);

  CREATE TABLE links (
    id         INTEGER PRIMARY KEY,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    position   REAL NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (item_id, kind, value)
  ) STRICT;

  -- Only grows. Nothing updates or deletes a row but deleting its item.
  CREATE TABLE log (
    id      INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    by      TEXT NOT NULL,
    text    TEXT NOT NULL,
    ref     TEXT
  ) STRICT;
  CREATE INDEX log_item ON log (item_id, id);
  `,
  // 2: when each item entered each status group, for the portfolio's
  // "open over 14 days" and "done this week". Triggers keep it, so no write
  // path can forget to: every write of items.status_id also stamps
  // updated_at, which is the time a change is recorded at. A status moving to
  // another group is recorded by the store, which has the clock.
  //
  // The backfill knows only what an item is now: an open item has been in its
  // group since it was made, a finished one was not started until its last
  // update.
  `
  CREATE TABLE status_history (
    id      INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    grp     TEXT NOT NULL CHECK (grp IN ('not-started', 'active', 'done', 'closed')),
    at      TEXT NOT NULL
  ) STRICT;
  CREATE INDEX status_history_item ON status_history (item_id, at);

  INSERT INTO status_history (item_id, grp, at)
    SELECT i.id, CASE WHEN s.grp IN ('done', 'closed') THEN 'not-started' ELSE s.grp END, i.created_at
      FROM items i JOIN statuses s ON s.id = i.status_id;
  INSERT INTO status_history (item_id, grp, at)
    SELECT i.id, s.grp, i.updated_at
      FROM items i JOIN statuses s ON s.id = i.status_id
     WHERE s.grp IN ('done', 'closed');

  CREATE TRIGGER status_history_insert AFTER INSERT ON items
  BEGIN
    INSERT INTO status_history (item_id, grp, at)
      SELECT NEW.id, grp, NEW.created_at FROM statuses WHERE id = NEW.status_id;
  END;

  CREATE TRIGGER status_history_update AFTER UPDATE OF status_id ON items
    WHEN (SELECT grp FROM statuses WHERE id = NEW.status_id) IS NOT (SELECT grp FROM statuses WHERE id = OLD.status_id)
  BEGIN
    INSERT INTO status_history (item_id, grp, at)
      SELECT NEW.id, grp, NEW.updated_at FROM statuses WHERE id = NEW.status_id;
  END;
  `
]

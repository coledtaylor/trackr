# Trackr

Work tracking for [Helm](https://github.com/coledtaylor/helm), the desktop
shell for Claude Code: portfolios, projects, epics and tasks, kept in one
SQLite file on your computer, with tools that let the Claude Code sessions
Helm starts read and update the work. It keeps and organises work; it does
not enforce a workflow.

Sessions get a task's spec, acceptance criteria and where the last session
stopped from `get`, and leave the next one a handoff with `update`. You see
and edit the same work in Helm's sidebar and tabs.

## Requirements

- Helm 2.2.0 or later, the first with tools for sessions. On an older Helm the
  pages work but sessions get no tools.
- Windows is where it is built and tested, as Helm is.
- Nothing else: the service runs on the Node inside Helm and uses its built-in
  SQLite. There are no runtime dependencies.

## Install

```
git clone https://github.com/coledtaylor/trackr.git
```

Then in Helm open Settings > Plugins, press **Add folder** and pick the
`trackr` folder. Its icon appears on the rail. To update, `git pull`: Helm
reloads the plugin when its files change.

Settings marks the plugin as one that runs a program. That program is
`service/main.mjs`: it opens the one database file and answers the plugin's
own pages on `127.0.0.1`, and only requests carrying the token Helm gives it
for that run. It reaches nothing else.

## Getting started

1. Open the **Trackr** panel from the rail and press **New portfolio**. Give it a
   name and a key (the key starts every ID: `TC` gives `TC-1`).
2. Its workflow opens. Add a project for each codebase, with the folder it
   lives in, so a session started there lands in it. Change the statuses and
   priorities here if the defaults do not fit.
3. Allow the tools in `~/.claude/settings.json` (see
   [Tools for sessions](#tools-for-sessions)), so sessions do not ask before
   each call.
4. Make epics and tasks from the panel's **+**, a portfolio's **New**, or by
   asking a session to plan the work; the session's `create` puts a whole plan
   in one call.

There is no import: bringing work over from another tracker is done by hand,
or by a session with `create`.

## What is here

```
helm-plugin.json     the manifest
service/main.mjs     the service Helm runs: owns the database, answers the pages over loopback
service/store.mjs    the store: every read and write of the model
service/schema.mjs   the schema, as migrations
service/model.mjs    status groups, colours, icons, link kinds, defaults
service/folders.mjs  how a working directory picks its project
service/rpc.mjs      the store methods the pages may call, and the tool route
service/tools.mjs    find, get, create and update: what a session calls
service/overview.mjs what the portfolio and project pages show: stats, epics per project, an epic's order
service/changes.mjs  how a change reads in the log, for sessions and the pages alike
pages/background.js  relays each session tool call to the service; keeps the rail badge
pages/panel.*        the sidebar panel
pages/view.*         the tab: loads the view for a portfolio, its workflow, a project or an item
pages/views/         one module per view
pages/shared/        what the pages share: the service call, the page channel, icons, styles,
                     the new task form, the in-page dialog, drag to reorder
test/                node:test suites for all of the above
```

## The model

```
Portfolio  key (TC), name, description, next number,
           statuses   [{name, group: not-started | active | done | closed, colour, icon}],
           priorities [{name}], in rank order
Project    portfolio, name, colour, folders []
Item       TC-123, kind epic | task, project, epic (tasks only), title,
           description, status, priority, position, waitsOn [ids],
           links [{kind, value, label}], criteria [{text, done}],
           handoff {done, left, next, by, at}, log [{at, by, text, ref}],
           session {id, name, activeAt}
```

- Epics and tasks share one number sequence per portfolio. The ID is the
  portfolio key plus the number, so it stays the same when a task moves
  between projects, and renaming the key renames every ID.
- An epic has a home project; its tasks can be in any project of the
  portfolio. Dependencies work across projects, never across portfolios, and
  cycles are refused.
- A status's group is what it means. Helm and agents read the group, so a
  custom status like "Awaiting launch" in the done group counts as done.
- A project lists its folders. The deepest folder that holds a session's
  working directory decides the project. A folder belongs to one project.
- Claiming a task for a session never refuses: it returns the session that
  had it.
- Marking a task done with criteria unchecked is allowed.

## In Helm

The rail icon opens the **Trackr** panel. Its badge is the number of tasks in an
active status, across every portfolio.

- **Doing now** lists those tasks, with the session on each.
- **Portfolios** lists each portfolio with its projects and their open task
  counts. The chevron folds a portfolio; the fold is remembered. **+** beside
  the heading makes a new portfolio: a name, a key (suggested from the name)
  and a description. It starts with the default statuses and priorities, and
  its workflow opens so its projects can be added.
- **Find** searches titles and descriptions across every portfolio, and an ID
  like `TC-12` puts that item first. Enter opens the first result.
- **+** in the header opens a new task form. The project starts as the one on
  screen; Ctrl Enter creates the task and opens it. A toggle makes it an epic
  instead, with a home project.

Rows open a tab:

- **A portfolio** shows a card per project, four stat cards (open tasks over 14
  days, in progress, waiting on another task, done this week), every epic with
  its tasks counted in each project, and the tasks in progress and waiting.
  **Workflow** opens its settings; **New** opens the new task form in a dialog.
- **A portfolio's workflow** is its settings, edited in place: statuses in
  their four groups (icon, colour, group, which one new tasks start in),
  priorities, projects (name, colour, folders) and the portfolio's name, key
  and description. Rows are put in order by dragging their handle, or with Up
  and Down on it. Deleting a status or priority that items use asks where they
  move; a project with items cannot be deleted; deleting the portfolio asks for
  its key to be typed. Changing the key asks first, since every ID changes.
- **A project** lists its tasks grouped by status, a box per status, or shows
  them as a board. Filters by epic, priority and whether a session is on a
  task. Each not-started group, and each board column, has a quick add: type a
  title, Enter saves. The sliders button opens the project's editor on the
  workflow page.
- **An epic** shows its progress in each project, its tasks in a box per
  project, the order they can be done in (each task hangs from the task it
  waits on), and its links. "Add a task" puts one in any project.
- **A task** shows its description, acceptance criteria, where it stands and
  the log, with its fields, dependencies and links beside them. Helm cannot
  start a session for a plugin yet, so the session button copies the prompt
  (`work on TC-123`) and says which folder to paste it in. Links are copied
  when pressed: a plugin cannot open them either.

Everything on an epic or task page is edited in place: the title and
description, status, priority, project and epic, criteria, where it stands,
dependencies (both ways) and links, and the session can be let go. An edit is
logged as "You", the way a session's update is logged with its name; checking
off criteria is not logged. Moving a task out of an active status lets go of
its session, as it does for a session's update.

**Delete**, under the column, asks first and says what goes with it: an
epic's tasks stay, without an epic. The tab then says it was deleted; a plugin
cannot close it.

The 14-day and this-week numbers come from `status_history`, which triggers
fill whenever an item changes status group. A database from before it was
added is backfilled from what each item is now.

Tabs tell the panel what they show, so the row for what is on screen is
marked. Every page reads again when another one changes the data,
and the background page does that after each `create` or `update` a session
makes.

Project colours are names (`blue`, `orange`, `green`, `amber`, `pink`), drawn
in a shade per light and dark theme by `pages/shared/work.css`; Helm has no
categorical palette yet.

A plugin cannot open a folder picker, so a project's folders are typed or
pasted as full paths; the quotes Explorer's "Copy as path" adds are dropped.
Helm draws every select as `base-select`, which ignores `overflow` on the
select, so the plugin's selects carry a face of their own
(`selectFace` in `pages/shared/dom.js`) that cuts a long option to one line.

## Tools for sessions

Sessions Helm starts get four tools, as `mcp__helm-plugin-trackr__<name>`:

```
find    one line per item, next up first; no arguments = open items in this folder's project
get     everything about one or more IDs; an epic lists its tasks by project
create  epics and tasks in one call, naming each other by temporary refs
update  several items in one call; says what became ready
```

`find` and `get` only read. Replies are plain text, written to be cheap for an
agent to read. `pages/background.js` registers the handlers and hands each call
to the service (`POST /tool`), where `service/tools.mjs` does the work next to
the database. Every agent write is logged with the session's name; setting an
item to an active status records the session on it, and a second session is
told who had it. There is no delete tool: agents set an item to Cancelled.

The tools load into every session Helm starts, whatever its folder; a project
needs nothing. Claude Code still asks before each call unless it is allowed.
The plugin sits above the projects, so the rule goes in the user settings,
`~/.claude/settings.json`, where it covers every session:

```json
{
  "permissions": {
    "allow": [
      "mcp__helm-plugin-trackr__find",
      "mcp__helm-plugin-trackr__get",
      "mcp__helm-plugin-trackr__create",
      "mcp__helm-plugin-trackr__update"
    ]
  }
}
```

Claude Code loads MCP tools on demand, so a session's first work call is
preceded by one tool search. A plugin cannot change that.

## What Helm does not give a plugin yet

A session cannot be started from a task, a link cannot be opened, a folder
cannot be picked, a tab cannot close itself, read-only tools still ask, and
the theme has no categorical colours. What the plugin does instead is described
above, next to each feature.

## Where the data lives

`~/.config/helm/data/trackr/trackr.db`, outside the plugin's folder, so it
survives a reinstall of the plugin, and Helm's watch on the plugin's files
never sees it change. `HELM_TRACKR_DB` moves it. The file is opened in WAL mode and writes take the lock up front, so
two Helms can have it open at once.

The service runs on the Node inside Helm and uses `node:sqlite`; there are no
runtime dependencies.

## Developing

Helm reloads the plugin when the manifest, `pages/` or `service/` change.
To try a change without touching your own data, point a Helm dev build at a
copy with `HELM_TRACKR_DB`.

```
npm install
npm run check        # typecheck, tests, helm-plugin validate
npm test             # tests only
```

The tests need Node 22.13 or later for `node:sqlite`. To run them on the Node
Helm gives the service:

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Helm/Helm.exe" --test "test/**/*.test.mjs"
```

## Licence

MIT. See [LICENSE](LICENSE).

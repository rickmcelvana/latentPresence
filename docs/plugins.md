# Writing a plugin for latentPresence

A plugin gives the character a new ability: a tarot deck, dice, a quiz, office tools. It is a folder
of plain files, a `plugin.json` that describes it and the files it names. **A plugin contains no
code.** Its tools are short lists of steps the app already knows how to run (draw from a table, roll
dice, look something up, fill in a sentence, remember a value, show something on the wall). If you
need more than that, a plugin can ask for an MCP server, and the person decides whether to add it.

This guide takes you from a copy of the template to a plugin someone else can install. The format is
`PluginManifest` in `packages/protocol/src/plugin.ts` (ADR-72); this page is the readable version.

## 1. Start from the template

Copy the folder `plugins/template/` from the repository (or download it from GitHub) and rename it
after your plugin, for example `my-dice`. It is a working plugin called Fortunes, with two tools:

- `draw_fortune` draws one row from `data/fortunes.json` and writes it on the whiteboard.
- `roll_dice` rolls dice like `3d6` and says the total.

Install it once as it is (step 5) to see it work, then change it into yours.

**Change the id first.** Open `plugin.json` and set `"id"` to your plugin's own name: 2 to 24
characters, lowercase letters, digits and hyphens, starting with a letter (`my-dice`). The id is the
plugin's namespace: its tools reach the model as `<id>__<tool>` (`my-dice__roll`), and a plugin
installed with the same id replaces the old one. Use the same name for the folder.

The first line, `"$schema"`, lets an editor such as VS Code check the file as you type and suggest
field names. Keep it.

## 2. The manifest

`plugin.json` at the top of the folder. Every field, in the order they usually appear:

| Field | What it is |
|---|---|
| `format` | Always `1`. |
| `id` | The namespace (see above). |
| `name` | What people see, up to 60 characters. |
| `version` | `1.0.0` style. Raise it when you change anything: the app shows it, and an update is offered by version. |
| `author`, `licence` | You, and the plugin's licence (`Apache-2.0`, `MIT`, `CC-BY-4.0`…). |
| `homepage` | Optional, an `https://` address. |
| `summary` | **One line the model reads** to decide when to use the plugin, up to 200 characters. Say what it does and when: "Draws tarot cards …; use it when someone asks for a reading." |
| `minApp` | The oldest app version it works with, `1.0.0` for now. |
| `instructions` | A Markdown file telling her how to use it (step 4). |
| `data` | Tables by name: `{ "fortunes": "data/fortunes.json" }`. |
| `tools` | What she can call (step 3). Up to 20. |
| `boards` | How shown things look on the wall. |
| `assets` | Pictures, pinned by size and SHA-256 (see "Pictures"). |
| `settings` | Choices the person makes in Settings → Plugins. |
| `mcp`, `schedules` | Optional: servers and schedules the plugin offers (see "Beyond steps"). |

An unknown field is an error, not ignored: in a hand-written file a misspelt field is nearly always
a mistake (`tool` for `tools`), and the check tells you so.

### Data tables

A table is a JSON file holding an array of objects, one per row, each with the same fields:

```json
[
  { "id": "door", "text": "A door you stopped noticing opens this week." },
  { "id": "letter", "text": "Write the letter; the answer is kinder than you fear." }
]
```

Give every row an `id` if a tool looks rows up. A table may have up to 5,000 rows (2 MB). Every
field you put in a row is handed to the model when the row is drawn, so a field like `meaning` is
how you tell her what a card means.

## 3. Tools

A tool has a `name` (lowercase letters, digits and underscores), a `description` the model reads, its
`parameters`, its `steps`, and `returns`: the steps whose results the model is given.

```json
{
  "name": "roll_dice",
  "description": "Rolls dice written like d20, 3d6 or 2d10+1. Returns the total and each die.",
  "parameters": {
    "dice": { "type": "string", "description": "The dice, like d20 or 3d6.", "default": "d6" }
  },
  "steps": [
    { "use": "roll", "as": "roll", "dice": "$args.dice" },
    { "use": "template", "as": "said", "text": "{{args.dice}}: {{roll.total}}" }
  ],
  "returns": ["roll", "said"]
}
```

**Parameters** are `string`, `number`, `integer` or `boolean`, each with a `description`. Optional:
`required`, `default`, `minimum`/`maximum` for numbers, and for strings `enum` (the only values
allowed) or `enumFrom` (the values of one column of a table: `{ "table": "spreads", "column": "id" }`).

**References.** Any string in a step that starts with `$` is a reference: `$args.dice` (a
parameter), `$settings.reversals` (a setting), or `$<step>` and a path into what that step made
(`$spread.positions`). Inside a template's text the same paths go in `{{ }}` without the `$`:
`{{roll.total}}`.

**Steps.** Each has `use` (which step) and usually `as` (the name its result goes by):

| Step | What it does | Fields |
|---|---|---|
| `draw` | Draws rows from a table without putting them back. Each drawn row gets `reversed` (true or false) and `slot`. | `table`; `count` (default: the number of slots, else 1); `slots` (labels in order, like a spread's positions); `reversed` (the chance a row comes up reversed: `0` to `1`, or `true` for a half) |
| `roll` | Rolls dice: `d20`, `3d6`, `2d10+1`. Makes `{ total, rolls }`. | `dice` |
| `lookup` | Finds the row whose `by` field (default `id`) equals `key`. | `table`, `key`, `by` |
| `template` | Fills `{{ }}` paths into a sentence. | `text` |
| `state` | Keeps a value for this character, kept with her memory. | `op`: `get` (needs `as`), `set` or `append` (need `value`), `clear`; `key` |
| `show` | Puts what a `draw` or `lookup` made on the wall. | `board`, `items` (like `"$cards"`), `title` |

Draws and rolls use the browser's secure random numbers, so the model cannot choose the cards: it
reads what the tool drew. That is the point of a tool: anything that must be fair, exact or
remembered belongs in a step, not in the model's imagination.

A tool runs without asking by default (`"policy": "auto"`), because steps touch nothing outside the
plugin. Set `"policy": "ask"` to have the person asked before each use.

### Boards: showing things on the wall

Behind her are two boards: the whiteboard on the left and the screen on the right. A `show` step
names a board from `boards`, which says how its items look:

```json
"boards": {
  "spread": { "layout": "cards", "image": "image", "flip": "reversed", "caption": "{{slot}}: {{name}}" },
  "fortune": { "layout": "list", "where": "whiteboard", "line": "{{text}}" }
}
```

- `cards`: a picture per item, from the asset named in the row's `image` field, with a caption.
  `flip` names a true/false field that turns the picture upside down (a reversed card). Up to 5
  cards fit one board; up to 10 spread across both.
- `list`: a line of text per item.
- `where`: `screen` (the default) or `whiteboard`.

The text is kept large enough to read in a call, so long captions are shortened or numbered.

### Pictures (assets)

Every picture is listed in `assets` with its exact size and SHA-256, so the person's consent covers
exactly those bytes and nothing can swap them later:

```json
{ "id": "card-1", "url": "https://example.com/cards/1.jpg", "type": "image/jpeg",
  "bytes": 53536, "sha256": "a8ef…", "licence": "Public domain", "source": "Where it came from" }
```

An asset is either in the folder (`"path": "img/1.png"`) or at an `https://` address (`"url"`). A
server must send `Access-Control-Allow-Origin` or the app cannot download from it. PNG, JPEG and
WebP, up to 20 MB each; pictures at an address download the first time they are shown.

You do not work out sizes and hashes by hand: list the assets leaving out `bytes` and `sha256`, then

```bash
pnpm plugin:check plugins/my-dice --pin
```

writes the real ones in. Only use pictures you may share, and say their licence: the consent screen
shows it.

### Settings

```json
"settings": {
  "reversals": { "type": "switch", "label": "Cards can come up reversed", "default": true }
}
```

Types: `switch` (true or false), `text`, `number` (with `minimum`, `maximum`) and `choice` (with
`choices`). Steps read them as `$settings.<key>`.

## 4. Instructions

The instructions file is Markdown, joined to her prompt while the plugin is in use. It is the most
important part to get right, and short is better (under about 4,000 characters; the most is 16,000).

What worked for Tarot and Office:

- Name each tool by its full name (`my-dice__roll`) and say exactly when to call it.
- Say what she must never do herself: "Never pick or name cards yourself: the tool draws them."
- Say "call it now, and speak after". Small models like to announce what they will do and then not
  do it.
- Say how to use what comes back: which field to read, and how long the answer should be.
- Write it for someone talking aloud: no tables, no headings she would read out.

## 5. Check it and try it

If you have the repository, check the folder as the app will:

```bash
pnpm plugin:check plugins/my-dice
```

It names every problem in a sentence, with where it is. `--fetch` also downloads and checks each
picture at an address.

Without the repository, the app runs the same check: in latentPresence open **Settings → Plugins →
Install from a folder…** and pick your folder. If something is wrong, it lists the same problems
instead of installing. If all is well you see the consent screen: what the plugin is, who made it,
every host it may contact, what it may download, its tools, and roughly how much it adds to each
request. Choose **Install**, turn it on for a character, and ask her to use it.

To change it, edit the files and install the folder again; raise `version` each time so you can
tell them apart.

## 6. Share it

- **As a zip**: zip the folder and send it. Others choose **Install from a .zip…**.
- **At an address**: put the folder on any web server that sends `Access-Control-Allow-Origin`
  (a GitHub repository works: use the "raw" address of `plugin.json`, ideally at a commit rather
  than a branch so it cannot change under people). Others paste the address under **Or its address**.
  The consent screen says it is not in the latentPresence index.
- **In the index**: the plugins Browse lists live in `plugins/index.json` in the
  `rickmcelvana/latentpresence.com` repository. To add yours, open a pull request with its entry.
  An entry names the manifest's address and the SHA-256 of `plugin.json` and of every other file it
  names, so a plugin changed after it was listed is refused until the index is updated. For a
  plugin in this repository, `pnpm plugin:index --out <site>/plugins/index.json plugins/my-dice`
  writes the entry from the last pushed commit.

## Beyond steps

- **MCP servers.** For anything steps cannot do (reading a calendar, calling a web service), a
  plugin can list servers in `mcp`: an HTTP server by its `url`, or a program by its `command` and
  `args`. Nothing is added silently. The person is asked about each one in Settings → Plugins. A
  program is added only in the desktop app, after a Windows dialog shows the whole command, and
  every tool of every server is still asked about before it runs.
- **Schedules.** `schedules` offers presets the person can make for a character, like "weekday
  mornings at 8: the day's plan". A preset has a `description`, a `cron` (`0 8 * * 1-5`), a
  `taskPrompt` (what she does), the `tools` she may use for it, and `delivery` (`notify`,
  `speak_next_session` or `silent_log`). Its tools may be the plugin's own, a server's
  (`<server id>__<tool>`), or the app's: `plan_list`, `schedule_list`, and the companion's Files
  tools (`files__read_document`, `files__write_spreadsheet`, …). Office does its work this way.

## When the check complains

| It says | Do this |
|---|---|
| `"x" names nothing: not $args, $settings or an earlier step` | A reference is misspelt, or the step it names comes later. |
| `{{name}} is not a field of "cards"` | A template or caption names a field the table's rows do not have. |
| `draws 10 from "cards", which has 5 rows` | Draws never repeat a row; add rows or draw fewer. |
| `… has SHA-256 …, and the manifest says …` | The picture changed; run `--pin` again. |
| `could not be downloaded` | The server is down, or it does not send `Access-Control-Allow-Origin`. |
| `It needs latentPresence 1.2.0 or newer` | Lower `minApp`, or update the app. |

Questions the guide did not answer are bugs in the guide: tell Rick, and they go in here.

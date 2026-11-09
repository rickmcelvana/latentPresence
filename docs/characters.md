# Making your own character

latentPresence comes with Alice and Theo. You can make your own: a tarot reader, a language tutor, a
character from your story. A character is who she is and how she talks; it does not change the
model, and it is kept in this browser until you export it. The format is `Persona` in
`packages/protocol/src/persona.ts` (ADR-74); this page is the readable version.

## Make one

Open **Settings → Character**.

- **New character** starts from Alice's lines with no name or summary.
- **Duplicate** copies the character shown, Alice and Theo included, as a new character of your own.
  Alice and Theo themselves cannot be edited: they improve with the app.
- **Edit** and **Delete…** appear on your own characters.

The form:

| Field | Limit | What it is |
|---|---|---|
| Name | 60 characters | Shown in the call. Renaming keeps everything they remember. |
| Who they are | 1,200 characters | One paragraph the model reads every turn: who they are, what they care about, how they see the person they talk to. |
| How they talk | 1 to 12 lines, 200 characters each | Short orders: "Answer first, explain second." |
| What they will not do | 1 to 12 lines, 200 characters each | "No predictions about health or money." At least one. |
| Voice, speed | Kokoro's voices, 0.75 to 1.25 | The browser voice. A voice chosen below the form, or a server voice, still wins. |
| Gestures | rarely, sometimes, often | How often they move their hands as they talk. |
| Body | the bodies you have | Worn when nothing else is chosen in the call, under Body. |

Under the form the app says about how many tokens the character adds to every request. All of it is
sent with every turn, so a long character costs time and money on a paid model.

**She always says she is an AI when someone sincerely asks.** The app puts that line first in every
prompt, above anything the character says. A line telling her to claim to be human gets a warning
in the editor and on import, never a refusal (you may mean a story), but some small models follow
such a line instead of the app's (`docs/runs/P11-T02-disclosure.md`).

### Writing tips

- Short imperative lines work far better than prose about a preference. "Ask one question at a
  time." beats "She tends to prefer asking questions one by one."
- Put facts about the world in "Who they are", habits in "How they talk".
- Leave out what every character does anyway (be helpful, be polite). Each line costs every turn.
- Try it: switch to the character in the call and talk for a few minutes, then edit.

## Plugins, voice and body

Plugins are turned on per character in **Settings → Plugins**, so your tarot reader can have the
Tarot plugin while Alice does not. The voice chosen in Settings → Character and the body chosen in
the call are yours, per character, and are not part of the character itself.

## Memory

A character's id is made once when it is first saved (`u-madame-vey-7k2q`) and never changes:
everything she remembers about you is kept under it. Renaming or editing keeps it all.

**Delete…** asks one question:

- **Delete, keeping what they remember.** The character goes; the memories stay under the id.
  Importing the character's file again brings them back.
- **Delete and forget everything.** Every turn, fact, plan, note and schedule under the id is
  deleted, in the browser's memory or the companion's database, whichever is in use.

## Share one

**Export** writes `<name>.persona.json`: the character alone. It holds no memories, no body, no
plugins and no settings, so it is safe to send to a friend or keep as a backup.

**Import…** reads a file you pick (nothing is fetched). The app checks it and either names every
problem in a sentence, or shows the name, the summary, the number of lines and the cost per turn
before anything is added. Then:

- **One of yours that is not here** keeps its id. If you deleted it keeping its memories, they come
  back.
- **One you already have** can replace yours (its memories, body and plugins kept) or be added as a
  new character.
- **A file with Alice's or Theo's id**, or an id this app would not make, comes in as a new
  character, remembering nothing. If you already have a character of that name, the new one is
  called "(imported)".

A voice the app does not have is replaced by Alice's, and the import says so.

To move a character to another browser or computer: Export here, Import there, then turn on its
plugins in Settings → Plugins. Its memories move only if both use the same companion database.

## The file

A character file is one JSON object, two-space indented:

```json
{
  "version": 1,
  "id": "u-madame-vey-7k2q",
  "name": "Madame Vey",
  "summary": "Madame Vey reads tarot cards for people who call. She learned the cards from books and says so.",
  "style": ["Speak slowly, as if a candle has just been lit.", "Ask one question at a time."],
  "boundaries": ["No predictions about health, money or death."],
  "voice": { "voiceId": "bf_emma", "speed": 0.95 },
  "expressiveness": { "gestures": "some" }
}
```

`version` is always 1. `id` is `u-` and lowercase letters, digits and hyphens; leave it as Export
wrote it. `gestures` is `rare`, `some` or `often`. Any other field is ignored. Files over 64 kB are
refused: a character is a few kB.

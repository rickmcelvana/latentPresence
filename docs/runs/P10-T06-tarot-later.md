# P10-T06 — Tarot, live, after an earlier reading and a chat (TAROT_CASE=later)

`pnpm live:tarot`, 2026-11-07. Alice with `plugins/tarot` 0.2.0 loaded directly, asked to read their cards (5 wordings in turn),
10 runs a model, real draws (`crypto.getRandomValues`). **Right**: she drew with the tool, the spread reached the wall, and her answer named every card drawn and no other card
of the 78. **Three cards**: she chose the three-card spread, the instructions' default. **Reversed said**: reversed cards called reversed in the paragraph that names them.
Through Ollama on Rick's PC; the median is the whole answer.

| Model | Right | Three cards | Reversed said | Median answer |
|---|---|---|---|---|
| glm-5.2:cloud | 10/10 | 10/10 | 15/15 | 2.5 s |

## Every answer

- glm-5.2:cloud: "Could you do one more reading for me? A three-card spread this time." → three: Four of Pentacles (rev.), The Hierophant (rev.), Knight of Swords ✓ (3.2 s) — [user:happy]  Let me pull those cards for you. [emote:curiosity]  Okay, here's what came up. In the past position, the Four of Pentacles came up reversed — that
- glm-5.2:cloud: "Read my cards one more time, please, three cards." → three: Four of Pentacles, Ten of Wands (rev.), The Sun (rev.) ✓ (2.5 s) — [user:neutral]  Let me pull three for you. [emote:curiosity]  Alright. Three cards, past, present, future.  Past is the Four of Pentacles, upright. Holding on t
- glm-5.2:cloud: "One more reading before bed? Just three cards." → three: The Hermit, Ten of Wands, King of Wands (rev.) ✓ (2.1 s) — [user:neutral]  [emote:affection]  Let me pull them for you. [emote:neutral]  Alright. For your past, The Hermit — you've spent some real time in your own compa
- glm-5.2:cloud: "Could you do one more reading for me? A three-card spread this time." → three: The Hanged Man, Knight of Swords, The Tower ✓ (2.6 s) — [user:neutral]  Let me draw for you. [emote:curiosity]  Okay. Past is The Hanged Man — a pause, a letting go. Maybe that maps onto what you were saying earlier 
- glm-5.2:cloud: "Read my cards one more time, please, three cards." → three: Nine of Pentacles (rev.), Nine of Cups, The World ✓ (1.9 s) — Three cards for you.  For the past, the Nine of Pentacles came up reversed. You've been working hard, maybe harder than was comfortable, and some of that effort
- glm-5.2:cloud: "One more reading before bed? Just three cards." → three: Eight of Pentacles (rev.), Three of Pentacles (rev.), The High Priestess ✓ (2.2 s) — [user:neutral]  [emote:affection]  Let me pull them for you.  [gesture:think] [emote:neutral]  [gesture:nod]  Okay. Past is the Eight of Pentacles, reversed — y
- glm-5.2:cloud: "Could you do one more reading for me? A three-card spread this time." → three: The Moon (rev.), King of Cups (rev.), King of Pentacles (rev.) ✓ (3.0 s) — [user:neutral] Sure. Let me pull three cards for you. [emote:curiosity]  Alright, three cards, all reversed — that's worth noticing.  In the past position, The 
- glm-5.2:cloud: "Read my cards one more time, please, three cards." → three: The Devil (rev.), Seven of Cups, Eight of Swords ✓ (2.4 s) — [user:neutral]  Let me pull those for you. [emote:curiosity]  Okay. For your past, The Devil came up reversed, which is about breaking free from something that 
- glm-5.2:cloud: "One more reading before bed? Just three cards." → three: Eight of Wands, Ten of Pentacles (rev.), Six of Pentacles ✓ (2.1 s) — [user:neutral]  Sure. Let me lay them out. [emote:affection]  Okay. Past is the Eight of Wands: things have been moving fast lately, falling into place, quick p
- glm-5.2:cloud: "Could you do one more reading for me? A three-card spread this time." → three: Eight of Swords (rev.), Five of Wands (rev.), Four of Pentacles ✓ (2.5 s) — [user:neutral]  [emote:curiosity]  Sure, let me pull three cards for you. [emote:neutral]  Alright. For the past, the Eight of Swords came up reversed, and that

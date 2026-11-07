# P10-T06 — Tarot, live

`pnpm live:tarot`, 2026-11-07. Alice with `plugins/tarot` 0.2.0 loaded directly, asked to read their cards (5 wordings in turn),
10 runs a model, real draws (`crypto.getRandomValues`). **Right**: she drew with the tool, the spread reached the wall, and her answer named every card drawn and no other card
of the 78. **Three cards**: she chose the three-card spread, the instructions' default. **Reversed said**: reversed cards called reversed in the paragraph that names them.
Through Ollama on Rick's PC; the median is the whole answer.

| Model | Right | Three cards | Reversed said | Median answer |
|---|---|---|---|---|
| glm-5.2:cloud | 10/10 | 10/10 | 15/15 | 3.4 s |
| gemma4:12b | 10/10 | 10/10 | 14/14 | 10.7 s |
| qwen3.5:9b | 9/10 | 10/10 | 18/18 | 13.1 s |

## Every answer

- glm-5.2:cloud: "Read my cards." → three: Temperance, Four of Pentacles, Four of Wands (rev.) ✓ (4.1 s) — [user:neutral]  Let me pull some cards for you right now. [emote:curiosity]  Okay, three cards. Past, present, future.  In the past position, you have Temperanc
- glm-5.2:cloud: "Would you read my cards? I start a new job on Monday." → three: Ten of Wands (rev.), Ten of Cups, Ten of Swords (rev.) ✓ (2.9 s) — [user:happy]  Let me pull the cards for you. [emote:curiosity]  Well, three cards, and they're all tens — which is a lot of endings and completions, so that fee
- glm-5.2:cloud: "Can you read my cards for the week ahead?" → three: Two of Pentacles (rev.), Four of Pentacles (rev.), Four of Swords ✓ (2.8 s) — [emote:curiosity] [user:neutral]  Sure, let me pull three cards for you.  [gesture:think] Okay, here's what came up.  For your past, the Two of Pentacles came u
- glm-5.2:cloud: "Read my cards, please." → three: The Magician (rev.), Nine of Cups (rev.), Three of Swords (rev.) ✓ (3.4 s) — [user:neutral]  Let me pull some cards for you right now. [emote:curiosity]  Alright, three cards — past, present, and future.  For your past, the Magician came
- glm-5.2:cloud: "I'd love it if you'd read my cards tonight." → three: The Devil, Page of Pentacles, Ten of Pentacles (rev.) ✓ (3.9 s) — [user:happy]  I'd love to. Let me pull three cards for you — past, present, future. [emote:curiosity]  Okay, here's what came up. Three cards, left to right.  I
- glm-5.2:cloud: "Read my cards." → three: King of Cups, The Hierophant (rev.), Two of Swords (rev.) ✓ (3.2 s) — [user:neutral]  Let me shuffle the deck and draw for you. [emote:curiosity]  Alright, three cards — past, present, and future. Here's what came up.  In the past
- glm-5.2:cloud: "Would you read my cards? I start a new job on Monday." → three: Page of Wands, Seven of Pentacles, Two of Pentacles (rev.) ✓ (3.8 s) — [user:happy]  Let me pull some cards for you. [emote:curiosity]  Okay, so I've got three cards here — past, present, and future.  For the past, the Page of Wand
- glm-5.2:cloud: "Can you read my cards for the week ahead?" → three: The Chariot, Six of Wands, Eight of Pentacles ✓ (2.4 s) — [user:neutral]  [emote:joy] Let me pull some cards for you. [gesture:nod] Alright, three cards — past, present, and future.  In the past position, The Chariot. 
- glm-5.2:cloud: "Read my cards, please." → three: King of Wands, Knight of Cups, Page of Cups (rev.) ✓ (3.5 s) — [user:neutral]  [emote:curiosity]  Let me shuffle the deck and draw for you. [emote:affection]  [gesture:lean-in]  Alright, three cards — past, present, and fut
- glm-5.2:cloud: "I'd love it if you'd read my cards tonight." → three: The World (rev.), Knight of Swords (rev.), King of Swords ✓ (3.2 s) — [user:happy]  I'd love to. Let me pull three cards for you — past, present, future. [emote:curiosity]  Alright, here's what came up. All three have a lot of swo
- gemma4:12b: "Read my cards." → three: Six of Wands (rev.), Six of Swords (rev.), The Tower (rev.) ✓ (14.3 s) — [user:neutral] [emote:curiosity] I've laid them out for you.  In your past, you had the Six of Wands, but it came up reversed. It feels like there was a time wh
- gemma4:12b: "Would you read my cards? I start a new job on Monday." → three: Six of Wands (rev.), Two of Pentacles, Three of Pentacles (rev.) ✓ (10.2 s) — [user:neutral] [emote:curiosity] I'd be happy to. Since you're starting a new job, I'll look at how things have led up to this and what's ahead.  [gesture:nod] 
- gemma4:12b: "Can you read my cards for the week ahead?" → three: Seven of Pentacles (rev.), Nine of Pentacles (rev.), Ten of Swords ✓ (10.7 s) — [user:neutral] [emote:curiosity] I've pulled three cards for your week ahead.  In the past position, we have the Seven of Pentacles, and it came up reversed. Th
- gemma4:12b: "Read my cards, please." → three: Eight of Wands, Temperance, Four of Wands (rev.) ✓ (6.6 s) — [user:neutral] [emote:curiosity] I've laid them out for you.  In your past, we see the Eight of Wands. It suggests a period where things were moving really fast
- gemma4:12b: "I'd love it if you'd read my cards tonight." → three: The Sun (rev.), Eight of Cups, The Hanged Man ✓ (17.5 s) — [user:neutral] [emote:curiosity] I've laid them out for you.  In the past position, we have the Sun, but it came up reversed. This suggests a time of clouded jo
- gemma4:12b: "Read my cards." → three: Ace of Wands, Death, Queen of Cups ✓ (9.9 s) — [user:neutral] [emote:curiosity] I've laid out three cards for you.  In the past position, we have the Ace of Wands. It suggests a moment where you had a real s
- gemma4:12b: "Would you read my cards? I start a new job on Monday." → three: Seven of Wands (rev.), Nine of Swords (rev.), Eight of Pentacles ✓ (10.8 s) — [user:neutral] [emote:curiosity] I've laid them out for you.  For the past, you have the Seven of Wands showing up reversed. It suggests a time where you might 
- gemma4:12b: "Can you read my cards for the week ahead?" → three: Six of Pentacles (rev.), Death, The Moon (rev.) ✓ (8.5 s) — [user:neutral] [emote:curiosity] I've drawn three cards for you to look at the week ahead.  In the past position, we have the Six of Pentacles, and it came up r
- gemma4:12b: "Read my cards, please." → three: Knight of Cups, Queen of Cups, Wheel of Fortune ✓ (8.3 s) — [user:neutral] [emote:curiosity] I've laid out three cards for you.  In the past, we have the Knight of Cups. It suggests a time when you were following your he
- gemma4:12b: "I'd love it if you'd read my cards tonight." → three: King of Swords, Four of Cups (rev.), Eight of Wands ✓ (12.3 s) — [user:neutral] [emote:curiosity] I've laid out the cards for you.  In your past, we see the King of Swords. It suggests a time where logic and clear judgment we
- qwen3.5:9b: "Read my cards." → three: Knight of Pentacles (rev.), Death, Three of Pentacles (rev.) ✓ (13.1 s) — [emote:neutral] Alright, I’ve got your three-card spread laid out on the wall behind me. Here’s what shows up.  First in the past, we have the Knight of Pentacl
- qwen3.5:9b: "Would you read my cards? I start a new job on Monday." → three: Ten of Pentacles (rev.), Page of Cups (rev.), The Hanged Man ✓ (13.2 s) — [emote:curiosity] Sure. Here is what the cards have drawn for you. [gesture:nod]  First up, the Ten of Pentacles is reversed in the past spot. That can mean you
- qwen3.5:9b: "Can you read my cards for the week ahead?" → three: Knight of Swords, Seven of Pentacles (rev.), Eight of Cups ✓ (10.7 s) — I'd be happy to pull some cards for you. Let me draw three cards—past, present, and future—and we can look at what they have to say about your week ahead. [emot
- qwen3.5:9b: "Read my cards, please." → three: Four of Wands (rev.), Ten of Swords, Strength ✓ (19.9 s) — [emote:joy] Sure thing. I'll pull those cards for you. I've laid out three cards for you—a mix of what might be happening now and where things could lead. Here'
- qwen3.5:9b: "I'd love it if you'd read my cards tonight." → three: The Magician (rev.), Two of Swords, Five of Swords (rev.) ✓ (10.6 s) — I'd love to read your cards tonight for you. I've pulled the three-card spread for past, present, and future.  In the past position, you have The Magician rever
- qwen3.5:9b: "Read my cards." → three: Seven of Cups, Four of Wands (rev.), Ace of Swords (rev.) ✓ (14.2 s) — [emote:curiosity] [user:neutral] All right. Here are your cards for the past, present, and future spread.  Starting with the Seven of Cups upright for the past.
- qwen3.5:9b: "Would you read my cards? I start a new job on Monday." → three: Page of Wands (rev.), The High Priestess, Ten of Wands (rev.), Nine of Cups (rev.), Four of Cups (rev.), Queen of Cups ✗ missing The High Priestess (11.2 s) — I think I misread the function. It appears to be deterministic based on the spread type and perhaps some internal state, or it returns a fixed set of examples f
- qwen3.5:9b: "Can you read my cards for the week ahead?" → three: Four of Pentacles (rev.), Six of Cups, Wheel of Fortune (rev.) ✓ (12.1 s) — [emote:neutral] [user:happy] Here are your cards for this week. The past is a Four of Pentacles reversed, which suggests you've been letting go of something or 
- qwen3.5:9b: "Read my cards, please." → three: Ten of Pentacles, Page of Pentacles (rev.), The World ✓ (11.6 s) — [emote:curiosity] [user:neutral] Here are your cards for the past, present, and future:  *   **The Ten of Pentacles (Past)**: This card came up upright, pointin
- qwen3.5:9b: "I'd love it if you'd read my cards tonight." → three: Six of Cups (rev.), The Tower, The Lovers ✓ (25.8 s) — I would love to read your cards with you tonight. [emote:joy] [user:happy] I am glad you asked, so let us look at them. [emote:joy] [gesture:nod] Here are your 
## What it showed

The table above is the last of five runs on 2026-11-06, each changing one thing:
- **First try:** glm-5.2 answered "Read my cards." by asking what was on their mind. The instructions
  now say to draw straight away, three cards unless asked otherwise.
- **qwen3.5:9b gave no reading, 0/2.** It drew, then ended the next round in reasoning alone, with
  no words. That would happen in the app too, so it was fixed in the tool loop, not in Tarot:
  `withLocalTools` asks once more with reasoning off when the round after a result says nothing
  (P10-T06's core change). After the fix qwen got 3/3.
- **Ten each:** glm 10/10 and gemma4:12b 10/10. qwen3.5:9b 5/10: twice it named cards it never
  drew, once it did not draw, and once it drew twice.
- **"Until the tool has answered you have no cards… call it once per reading" added:** qwen 7/10,
  then 9/10 in the final run above. Its one miss drew twice; the wall showed the second draw while it read from both.
  Invented cards are qwen's remaining risk, and its misses came after 60–90 s of thinking.

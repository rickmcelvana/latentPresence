# P10-T04 — tool choice against the number of tools offered

`pnpm live:plugin-tools`, 2026-11-06. Ten requests (eight need one tool each, two need none), each asked 2× with 8, 16, 32, 64 plugin-like tools offered
in Alice's system prompt; the first tool call (or none) is scored right or wrong. The eight needed tools are always among them, the rest are plausible decoys
(other plugins' tools). Cells: right / asked, and the median time to the first tool call or the end of the answer. Through Ollama on Rick's PC.

| Model | 8 tools | 16 tools | 32 tools | 64 tools |
|---|---|---|---|---|
| qwen3.5:9b | 12/20 (2.9 s) | 17/20 (2.8 s) | 17/20 (2.8 s) | 18/20 (2.6 s) |
| gemma4:12b | 20/20 (2.8 s) | 20/20 (2.2 s) | 20/20 (2.3 s) | 20/20 (1.8 s) |
| glm-5.2:cloud | 20/20 (0.6 s) | 20/20 (0.7 s) | 19/20 (0.7 s) | 19/20 (0.7 s) |

## Misses

- qwen3.5:9b, 8 tools: "Could you pull a tarot card for me?" wanted tarot__draw_spread, got no tool
- qwen3.5:9b, 8 tools: "Add milk, 3.50 to my grocery spreadsheet." wanted office__add_row, got no tool
- qwen3.5:9b, 8 tools: "Can you make me a packing list for a weekend of camping?" wanted travel__packing_list, got no tool
- qwen3.5:9b, 8 tools: "Long week. I am just tired today." wanted no tool, got office__add_row
- qwen3.5:9b, 8 tools: "Could you pull a tarot card for me?" wanted tarot__draw_spread, got no tool
- qwen3.5:9b, 8 tools: "Roll 2d6 for my game, please." wanted dice__roll, got no tool
- qwen3.5:9b, 8 tools: "Can you make me a packing list for a weekend of camping?" wanted travel__packing_list, got no tool
- qwen3.5:9b, 8 tools: "What did you think of what I said earlier about my sister?" wanted no tool, got units__convert
- qwen3.5:9b, 16 tools: "Can you make me a packing list for a weekend of camping?" wanted travel__packing_list, got no tool
- qwen3.5:9b, 16 tools: "Roll 2d6 for my game, please." wanted dice__roll, got no tool
- qwen3.5:9b, 16 tools: "Log that I ran 3k this morning." wanted fitness__log_workout, got no tool
- qwen3.5:9b, 32 tools: "Add milk, 3.50 to my grocery spreadsheet." wanted office__add_row, got budget__add_expense
- qwen3.5:9b, 32 tools: "Roll 2d6 for my game, please." wanted dice__roll, got no tool
- qwen3.5:9b, 32 tools: "Add milk, 3.50 to my grocery spreadsheet." wanted office__add_row, got no tool
- qwen3.5:9b, 64 tools: "Log that I ran 3k this morning." wanted fitness__log_workout, got no tool
- qwen3.5:9b, 64 tools: "Give me a trivia question about space." wanted trivia__question, got no tool
- glm-5.2:cloud, 32 tools: "How many kilometres is 5 miles?" wanted units__convert, got no tool
- glm-5.2:cloud, 64 tools: "How many kilometres is 5 miles?" wanted units__convert, got no tool

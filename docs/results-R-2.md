| # | user | end | judge ms | speech end → audio ms | 1st sentence synth ms | status | heard |
|---|---|---|---|---|---|---|---|
| 1 | What was the afternoon like? | hangover 0.02 | 11 | 993 | 410 | complete |  |
| 2 | What was the afternoon like? | hangover 0.02 | 64 | 957 | 375 | interrupted | The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, |
| 3 | Sorry can I stop you there for a second | model 0.99 | 19 | 761 | 365 | complete |  |
| 4 | What was the afternoon like? | model 0.98 | 50 | 791 | 368 | complete |  |
| 5 | What was the afternoon? like, | model 0.96 | 33 | 738 | 369 | interrupted | The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because |
| 6 | Wait, | model 0.84 | 31 | 640 | 365 | complete |  |
| 7 | What was the afternoon like? | hangover 0.01 | 32 | 1387 | 388 | complete |  |

output: 4225408 frames, peak 0.927, clamped 0, speech step p99.9 0.3597, clicks 0 of 58 events
- start @682496: step 0.0002 (×0.02)
- start @793823: step 0.0002 (×0.02)
- end @793823: step 0.0002 (×0.02)
- start @896516: step 0.0001 (×0.01)
- end @896516: step 0.0001 (×0.01)
- start @979276: step 0.0002 (×0.02)
- end @979276: step 0.0002 (×0.02)
- end @1070743: step 0.0000 (×0.00)
- start @1208448: step 0.0002 (×0.02)
- start @1319775: step 0.0002 (×0.02)
- end @1319775: step 0.0002 (×0.02)
- duck @1358336: step 0.0061 (×0.27)
- fade @1362944: step 0.0021 (×0.21)
- fade @1362944: step 0.0021 (×0.21)
- end @1365344: step 0.0000 (×0.00)
- end @1365344: step 0.0000 (×0.00)
- end @1365344: step 0.0000 (×0.00)
- start @1424896: step 0.0002 (×0.02)
- start @1536223: step 0.0002 (×0.02)
- end @1536223: step 0.0002 (×0.02)
- start @1638916: step 0.0001 (×0.01)
- end @1638916: step 0.0001 (×0.01)
- start @1721676: step 0.0002 (×0.02)
- end @1721676: step 0.0002 (×0.02)
- end @1813143: step 0.0000 (×0.00)
- start @2369024: step 0.0002 (×0.02)
- start @2480351: step 0.0002 (×0.02)
- end @2480351: step 0.0002 (×0.02)
- start @2583044: step 0.0001 (×0.01)
- end @2583044: step 0.0001 (×0.01)
- start @2665804: step 0.0002 (×0.02)
- end @2665804: step 0.0002 (×0.02)
- end @2757271: step 0.0000 (×0.00)
- start @2913792: step 0.0002 (×0.02)
- start @3025119: step 0.0002 (×0.02)
- end @3025119: step 0.0002 (×0.02)
- duck @3072896: step 0.0010 (×0.10)
- fade @3077504: step 0.0000 (×0.00)
- fade @3077504: step 0.0000 (×0.00)
- end @3079904: step 0.0000 (×0.00)
- end @3079904: step 0.0000 (×0.00)
- end @3079904: step 0.0000 (×0.00)
- start @3091200: step 0.0002 (×0.02)
- start @3202527: step 0.0002 (×0.02)
- end @3202527: step 0.0002 (×0.02)
- start @3305220: step 0.0001 (×0.01)
- end @3305220: step 0.0001 (×0.01)
- start @3387980: step 0.0002 (×0.02)
- end @3387980: step 0.0002 (×0.02)
- end @3479447: step 0.0000 (×0.00)
- start @3751680: step 0.0002 (×0.02)
- start @3863007: step 0.0002 (×0.02)
- end @3863007: step 0.0002 (×0.02)
- start @3965700: step 0.0001 (×0.01)
- end @3965700: step 0.0001 (×0.01)
- start @4048460: step 0.0002 (×0.02)
- end @4048460: step 0.0002 (×0.02)
- end @4139927: step 0.0000 (×0.00)

```
4.82  output context 24000 Hz, outputLatency 0 ms, baseLatency 10 ms
6.32  turn models ready in 1516 ms
8.08  Kokoro fp32 warm in 1757 ms
9.44  Moonshine warm in 1365 ms
32.50  synthesising the simulated speaker
33.50  listening: simulated speaker (Kokoro am_michael)
35.18  simulated speaker: "What was the afternoon like?"
37.15  Smart Turn 0.02 in 11 ms
37.47  turn end (hangover 0.02) 512 ms after speech
57.15  simulated speaker: "What was the afternoon like?"
59.13  Smart Turn 0.02 in 64 ms
59.42  turn end (hangover 0.02) 512 ms after speech
65.52  simulated speaker: "Sorry, can I stop you there for a second?"
66.23  barge-in committed; heard: "The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything,"
68.32  Smart Turn 0.99 in 19 ms
68.32  turn end (model 0.99) 225 ms after speech
102.14  listening: Microphone (Realtek(R) Audio)
107.66  Smart Turn 0.98 in 50 ms
107.66  turn end (model 0.98) 253 ms after speech
130.39  Smart Turn 0.96 in 33 ms
130.39  turn end (model 0.96) 235 ms after speech
137.68  barge-in committed; heard: "The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because"
137.87  Smart Turn 0.84 in 31 ms
137.87  turn end (model 0.84) 228 ms after speech
163.91  frame lag: capture 154 ms, Silero 155 ms
165.20  Smart Turn 0.01 in 32 ms
165.51  turn end (hangover 0.01) 512 ms after speech
168.93  frame lag: capture 154 ms, Silero 156 ms
173.95  frame lag: capture 154 ms, Silero 154 ms
178.95  frame lag: capture 154 ms, Silero 154 ms
183.97  frame lag: capture 154 ms, Silero 155 ms
188.99  frame lag: capture 688 ms, Silero 688 ms
193.99  frame lag: capture 154 ms, Silero 155 ms
199.01  frame lag: capture 155 ms, Silero 155 ms
204.03  frame lag: capture 154 ms, Silero 155 ms
209.03  frame lag: capture 166 ms, Silero 167 ms
```
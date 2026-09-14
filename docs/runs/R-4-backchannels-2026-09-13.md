# R-4 · Hear the backchannels, and talk into them — run 2026-09-13

Run by Rick on the Windows box (Chromium, Realtek(R) Audio microphone) at `/dev/voice`,
straight after P1-T09 landed; instructions as run are `docs/TASKS.md` R-4 at af93339 (now
Done, D-18). Two pastes: the duck session (simulated story, then microphone) and the cut
session (microphone). Analysed the same day; ADR-28 was accepted on it.

## By ear (Rick)

- **Story (step 1):** short words in the pauses, then the full answer at the end.
- **Microphone, duck (step 2):** "performed well".
- **Cut, and speakers (Rick's note 4):** cut "seemed to cut in more and talk longer instead of
  short cut-ins like duck". No pickup of the speakers while the character talked. No odd
  sounding words; "nothing sounded wrong".
- **ADR-28:** approved.

## Reading

- **The rules held with a person's pauses.** Microphone, duck: 4 clips in ~65 s, 14.2–21.6 s
  apart. Story: 3 clips, 9.5 and 9.7 s apart. None started while the character was
  answering; every clip followed a Smart Turn answer under 0.7 (0.01–0.51).
- **Every clip started inside a turn was talked into, and ducked**: the story's "Yes." and
  "Oh." (255 and 11 ms after being queued), the microphone's "Right." and "Yes." (181 and
  21 ms). With the cut run's one clip (73 ms) and P1-T09's browser runs, **10 of 10
  mid-turn clips were talked into before they finished** — a person's pauses are no longer
  than Kokoro's.
- **The cut run hardly tested cut.** It played **one** clip in ~68 s ("Yes.", cut 73 ms after
  it was queued — with the 50 ms fade, a blip at most). Most of that session's turns were
  short, so they rarely carried the 3 s `minSpeechMs`, and much of the rest of the time the
  character was answering. **What sounded like "cutting in more and talking longer" was the
  character's answers**: 10 answers reached audio and 9 were barged into, three after
  ~1–8 s of talking (rows 5, 7, 20), against 8 answers and 7 barge-ins in the duck session's
  microphone part. Turn-taking is the same code in both modes; the setting only touches the
  clip. Duck stays the default on the short cut-ins Rick heard, and the one cut clip adds to
  the evidence that a cut leaves nothing to hear.
- **A clip before the answer, again, and it sounded fine.** Story: "Right." then the hangover
  (0.03), as in two of P1-T09's three runs. Microphone: "Oh." (0.01) and "Yes." (0.39), each
  followed by the hangover 310 ms later and the answer ~190–300 ms after the clip ended, by
  the log's clock. 3 of the duck session's 7 clips. Rick heard "short words, then the full
  answer" and nothing wrong; the output queue is sequential, so a clip can delay an answer but
  never overlap it.
- **Speakers:** no pickup of the character by the microphone, as in R-2.
- **Instrument bug, fixed (8902c06).** Duck rows 7 and 16 read 6132 and 4311 ms from speech
  end to audio. Neither answer ever played — each was superseded by more speech — and the
  column took the next thing the output started, a backchannel (88.87 s and 124.65 s, within
  80 ms of the computed times). The harness now counts only segments the reply queued.
- **The rough edge is turn ends inside a story, not backchannels.** Mid-story pauses ended
  the turn — by the model ("There," scored 0.74 and 0.97) or by the hangover when a pause ran
  past 512 ms — and the character got as far as "The" before being talked over: 5 times in
  the duck session, 6 in the cut one. ADR-25 retracts a model end only inside the hangover,
  and a hangover end is final. P1-T14's to weigh. One person, one run.

## Raw output (copied from the page)

### Duck — story (step 1), then microphone with headphones (step 2)

| # | user | end | judge ms | speech end → audio ms | 1st sentence synth ms | status | heard |
|---|---|---|---|---|---|---|---|
| 1 | So yesterday I finally walked down to the old harbour, | model 0.97 | 10 | — | 371 | retracted |  |
| 2 |  | model 0.91 | 11 | — | — | retracted |  |
| 3 |  | model 0.72 | 32 | — | — | retracted |  |
| 4 |  | model 0.82 | 10 | — | — | retracted |  |
| 5 | So yesterday I finally walked down to the old harbor, the one past the station, and the tide was so far out that you could see all the boats just sitting on the mud, and there was this man with a dog who kept trying to walk out to one of them. Anyway, after about ten minutes he gave up and went to get a coffee, and I ended up talking to him for nearly an hour about the town, and how it used to be. | hangover 0.03 | 11 | 2444 | 385 | complete |  |
| 6 | Today I went for a walk in the woods. | model 0.93 | 24 | — | 385 | answering |  |
| 7 | There was a lot of wildlife. | model 0.70 | 10 | 6132 | 371 | answering |  |
| 8 | I saw squirrels playing in a tree, then as I turned around, I saw three deer. | hangover 0.01 | 22 | 950 | 359 | interrupted | The afternoon light came in low across the desk, and it |
| 9 | Walking down to the lake. | model 0.75 | 5 | 698 | 370 | interrupted | The afternoon light came in low |
| 10 | S. and yeast in the water. | hangover 0.45 | 8 | 940 | 367 | interrupted | The |
| 11 | As I walked further, I noticed a red box, snicking a drink at the corner of the lake, | hangover 0.39 | 21 | 947 | 359 | interrupted | The |
| 12 | After that, I'll walk up a big hill and can see for miles. | model 0.96 | 9 | — | 361 | answering |  |
| 13 | There, | model 0.74 | 12 | 611 | 359 | interrupted | The |
| 14 | Often the distance I could see a large river and boats going up and down. | model 0.97 | 9 | 828 | 376 | interrupted | The |
| 15 | At then walked back to the lake and swam for a while. | model 0.90 | 8 | — | 370 | answering |  |
| 16 | A then walked back home, and well, | hangover 0.08 | 8 | 4311 | 368 | answering |  |
| 17 | It started storming all of a sudden. It actually felt good. And well, I just enjoyed it and then walked slowly home. | hangover 0.04 | 7 | — | 356 | answering |  |
| 18 | I came home, | hangover 0.66 | 10 | — | 356 | answering |  |
| 19 | And Gerado, and then. | hangover 0.01 | 4 | — | 355 | answering |  |
| 20 | Made myself a nice warm cup of tea, | model 0.80 | 6 | 717 | 373 | interrupted | The |
| 21 | I'm now outside looking at the moon in a joying, a pleasantly cool night. | hangover 0.01 | 7 | 948 | 369 | complete |  |

```
13.04  output context 24000 Hz, outputLatency 0 ms, baseLatency 10 ms
14.52  turn models ready in 1495 ms
16.46  Kokoro fp32 warm in 1943 ms
17.69  Moonshine warm in 1227 ms
18.28  backchannels ready in 587 ms: "Yeah." 483 ms, "Right." 571 ms, "Yes." 563 ms, "Oh." 449 ms
21.10  synthesising the simulated speaker
25.64  listening: simulated speaker (Kokoro am_michael)
26.44  simulated speaker: "So yesterday I finally walked down to the old harbour, the one past the station, and …"
29.72  Smart Turn 0.97 in 10 ms
29.72  turn end (model 0.97) 213 ms after speech
29.98  turn resumed after a 448 ms pause (ADR-25)
31.42  Smart Turn 0.91 in 11 ms
31.42  turn end (model 0.91) 211 ms after speech
31.55  turn resumed after a 320 ms pause (ADR-25)
32.01  Smart Turn 0.01 in 10 ms
32.01  backchannel "Yes." 193 ms into the pause
32.28  backchannel "Yes." ducked: speech resumed 255 ms after it was queued
36.51  Smart Turn 0.03 in 29 ms
37.24  Smart Turn 0.01 in 20 ms
41.50  Smart Turn 0.51 in 27 ms
41.50  backchannel "Oh." 213 ms into the pause
41.53  backchannel "Oh." ducked: speech resumed 11 ms after it was queued
45.12  Smart Turn 0.72 in 32 ms
45.12  turn end (model 0.72) 214 ms after speech
45.28  turn resumed after a 352 ms pause (ADR-25)
45.73  Smart Turn 0.01 in 7 ms
49.58  Smart Turn 0.82 in 10 ms
49.58  turn end (model 0.82) 197 ms after speech
49.88  turn resumed after a 480 ms pause (ADR-25)
51.22  Smart Turn 0.03 in 11 ms
51.22  backchannel "Right." 202 ms into the pause
51.55  turn end (hangover 0.03) 512 ms after speech
75.85  listening: Microphone (Realtek(R) Audio)
78.69  Smart Turn 0.07 in 53 ms
80.68  Smart Turn 0.93 in 24 ms
80.68  turn end (model 0.93) 231 ms after speech
83.00  Smart Turn 0.70 in 10 ms
83.00  turn end (model 0.70) 217 ms after speech
85.54  Smart Turn 0.70 in 8 ms
88.87  Smart Turn 0.01 in 22 ms
88.87  backchannel "Oh." 230 ms into the pause
89.18  turn end (hangover 0.01) 512 ms after speech
89.87  Smart Turn 0.96 in 9 ms
89.87  turn end (model 0.96) 208 ms after speech
92.54  barge-in committed; heard: "The afternoon light came in low across the desk, and it"
92.77  Smart Turn 0.39 in 8 ms
93.83  Smart Turn 0.75 in 5 ms
93.83  turn end (model 0.75) 200 ms after speech
94.60  Smart Turn 0.09 in 7 ms
94.94  turn end (hangover 0.09) 512 ms after speech
95.72  Smart Turn 0.98 in 6 ms
95.72  turn end (model 0.98) 200 ms after speech
95.77  turn resumed after a 224 ms pause (ADR-25)
95.97  barge-in committed; heard: "The afternoon light came in low"
97.00  Smart Turn 0.45 in 8 ms
97.34  turn end (hangover 0.45) 512 ms after speech
97.92  barge-in committed; heard: "The"
98.31  Smart Turn 0.06 in 6 ms
100.46  Smart Turn 0.39 in 10 ms
103.08  Smart Turn 0.39 in 21 ms
103.08  backchannel "Yes." 231 ms into the pause
103.39  turn end (hangover 0.39) 512 ms after speech
104.00  barge-in committed; heard: "The"
104.68  Smart Turn 0.02 in 6 ms
107.76  Smart Turn 0.96 in 9 ms
107.76  turn end (model 0.96) 210 ms after speech
108.75  Smart Turn 0.74 in 12 ms
108.75  turn end (model 0.74) 209 ms after speech
109.31  barge-in committed; heard: "The"
110.36  Smart Turn 0.55 in 11 ms
113.83  Smart Turn 0.97 in 9 ms
113.83  turn end (model 0.97) 200 ms after speech
114.75  barge-in committed; heard: "The"
116.29  Smart Turn 0.01 in 8 ms
117.70  Smart Turn 0.90 in 8 ms
117.70  turn end (model 0.90) 199 ms after speech
119.72  Smart Turn 0.47 in 7 ms
120.59  Smart Turn 0.08 in 8 ms
120.93  turn end (hangover 0.08) 512 ms after speech
123.05  Smart Turn 0.01 in 5 ms
124.65  Smart Turn 0.01 in 8 ms
124.65  backchannel "Right." 203 ms into the pause
124.86  backchannel "Right." ducked: speech resumed 181 ms after it was queued
125.85  Smart Turn 0.01 in 18 ms
127.17  Smart Turn 0.01 in 23 ms
127.85  Smart Turn 0.01 in 6 ms
128.82  Smart Turn 0.04 in 7 ms
129.15  turn end (hangover 0.04) 512 ms after speech
130.35  Smart Turn 0.66 in 10 ms
130.69  turn end (hangover 0.66) 512 ms after speech
131.75  Smart Turn 0.30 in 7 ms
132.44  Smart Turn 0.01 in 4 ms
132.80  turn end (hangover 0.01) 512 ms after speech
135.43  Smart Turn 0.80 in 6 ms
135.43  turn end (model 0.80) 205 ms after speech
136.19  barge-in committed; heard: "The"
138.12  Smart Turn 0.29 in 9 ms
139.91  Smart Turn 0.02 in 8 ms
139.91  backchannel "Yes." 203 ms into the pause
139.97  backchannel "Yes." ducked: speech resumed 21 ms after it was queued
140.49  Smart Turn 0.01 in 10 ms
140.93  Smart Turn 0.01 in 7 ms
141.28  turn end (hangover 0.01) 512 ms after speech
```

### Cut — microphone (Rick's note 4)

| # | user | end | judge ms | speech end → audio ms | 1st sentence synth ms | status | heard |
|---|---|---|---|---|---|---|---|
| 1 | Today I went for a walk in the woods. | hangover 0.02 | 9 | — | 424 | answering |  |
| 2 | There was a lot of wildlife | hangover 0.64 | 10 | — | 439 | answering |  |
| 3 | I saw swirls playing their treat | hangover 0.23 | 8 | — | 375 | answering |  |
| 4 | Then, as I want to round, | hangover 0.29 | 10 | — | 370 | answering |  |
| 5 | I saw three beer looking | hangover 0.51 | 11 | 939 | 357 | interrupted | The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because there was nothing that needed |
| 6 | Or either I know it. | model 0.98 | 8 | — | 369 | retracted |  |
| 7 | Further, I know this is a brand of popular music. | model 0.75 | 9 | 765 | 361 | interrupted | The afternoon light came in low across the desk, and it caught the dust in |
| 8 |  | model 0.89 | 7 | — | — | retracted |  |
| 9 | After that, I walked up a big hill and see for miles. | model 0.99 | 9 | — | 371 | answering |  |
| 10 | There, | model 0.97 | 7 | 611 | 360 | interrupted | The |
| 11 |  | model 0.98 | 10 | — | — | retracted |  |
| 12 | Often the distance, I can see a large room with the most joyful town. | model 0.94 | 10 | 845 | 356 | interrupted | The |
| 13 | Then walk back to the lake and swam for a walk. | model 0.99 | 7 | 784 | 372 | interrupted | The |
| 14 | And then, one black home. | hangover 0.52 | 17 | 936 | 363 | interrupted | The |
| 15 | And well, they started storming all of a sudden. They actually felt good. And well, I just enjoyed it and then walked slowly home. | hangover 0.09 | 14 | 1035 | 363 | interrupted | The |
| 16 | A gay home, | hangover 0.20 | 7 | — | 359 | answering |  |
| 17 | And dried all. | hangover 0.18 | 11 | — | 355 | answering |  |
| 18 |  | model 0.83 | 7 | — | — | retracted |  |
| 19 | Then made myself a nice warm thumbs up seat | model 0.92 | 6 | 737 | 365 | interrupted | The |
| 20 | Now outside we're being at the moon | hangover 0.01 | 9 | 955 | 376 | interrupted | The afternoon light came |
| 21 | It all. | hangover 0.05 | 6 | 942 | 363 | complete |  |

```
72.36  output context 24000 Hz, outputLatency 0 ms, baseLatency 10 ms
73.74  turn models ready in 1396 ms
75.46  Kokoro fp32 warm in 1726 ms
76.75  Moonshine warm in 1285 ms
77.34  backchannels ready in 587 ms: "Yeah." 483 ms, "Right." 571 ms, "Yes." 563 ms, "Oh." 449 ms
96.88  listening: Microphone (Realtek(R) Audio)
101.87  Smart Turn 0.16 in 10 ms
102.51  Smart Turn 0.02 in 9 ms
102.84  turn end (hangover 0.02) 512 ms after speech
105.05  Smart Turn 0.64 in 10 ms
105.37  turn end (hangover 0.64) 512 ms after speech
107.81  Smart Turn 0.23 in 8 ms
108.15  turn end (hangover 0.23) 512 ms after speech
108.87  Smart Turn 0.12 in 7 ms
110.40  Smart Turn 0.29 in 10 ms
110.75  turn end (hangover 0.29) 512 ms after speech
112.17  Smart Turn 0.51 in 11 ms
112.51  turn end (hangover 0.51) 512 ms after speech
121.18  barge-in committed; heard: "The afternoon light came in low across the desk, and it caught the dust in the air. For a while nobody said anything, because there was nothing that needed"
121.89  Smart Turn 0.98 in 8 ms
121.89  turn end (model 0.98) 200 ms after speech
122.04  turn resumed after a 320 ms pause (ADR-25)
122.79  Smart Turn 0.75 in 9 ms
122.79  turn end (model 0.75) 203 ms after speech
124.81  Smart Turn 0.88 in 10 ms
124.81  turn end (model 0.88) 202 ms after speech
127.19  barge-in committed; heard: "The afternoon light came in low across the desk, and it caught the dust in"
127.36  Smart Turn 0.05 in 7 ms
128.11  Smart Turn 0.89 in 7 ms
128.11  turn end (model 0.89) 208 ms after speech
128.12  turn resumed after a 192 ms pause (ADR-25)
128.96  Smart Turn 0.26 in 8 ms
130.24  Smart Turn 0.99 in 9 ms
130.24  turn end (model 0.99) 195 ms after speech
131.17  Smart Turn 0.97 in 7 ms
131.17  turn end (model 0.97) 196 ms after speech
131.80  barge-in committed; heard: "The"
135.73  Smart Turn 0.98 in 10 ms
135.73  turn end (model 0.98) 210 ms after speech
135.80  turn resumed after a 256 ms pause (ADR-25)
136.72  Smart Turn 0.94 in 10 ms
136.72  turn end (model 0.94) 216 ms after speech
137.59  barge-in committed; heard: "The"
138.45  Smart Turn 0.02 in 9 ms
139.07  Smart Turn 0.32 in 7 ms
140.49  Smart Turn 0.99 in 7 ms
140.49  turn end (model 0.99) 203 ms after speech
141.53  barge-in committed; heard: "The"
142.05  Smart Turn 0.02 in 7 ms
143.19  Smart Turn 0.52 in 17 ms
143.51  turn end (hangover 0.52) 512 ms after speech
144.22  barge-in committed; heard: "The"
144.61  Smart Turn 0.05 in 5 ms
148.88  Smart Turn 0.01 in 10 ms
148.88  backchannel "Yes." 215 ms into the pause
148.99  backchannel "Yes." cut: speech resumed 73 ms after it was queued
150.85  Smart Turn 0.04 in 32 ms
151.59  Smart Turn 0.03 in 8 ms
152.57  Smart Turn 0.09 in 14 ms
152.89  turn end (hangover 0.09) 512 ms after speech
153.75  barge-in committed; heard: "The"
154.43  Smart Turn 0.20 in 7 ms
154.78  turn end (hangover 0.20) 512 ms after speech
155.87  Smart Turn 0.18 in 11 ms
156.22  turn end (hangover 0.18) 512 ms after speech
158.69  Smart Turn 0.04 in 5 ms
158.98  Smart Turn 0.83 in 7 ms
158.98  turn end (model 0.83) 201 ms after speech
159.03  turn resumed after a 224 ms pause (ADR-25)
159.23  Smart Turn 0.92 in 6 ms
159.23  turn end (model 0.92) 196 ms after speech
160.38  barge-in committed; heard: "The"
162.32  Smart Turn 0.01 in 9 ms
162.65  turn end (hangover 0.01) 512 ms after speech
163.75  Smart Turn 0.98 in 5 ms
163.75  turn end (model 0.98) 203 ms after speech
164.28  barge-in committed; heard: "The afternoon light came"
164.48  Smart Turn 0.07 in 6 ms
164.83  Smart Turn 0.05 in 6 ms
165.18  turn end (hangover 0.05) 512 ms after speech
```
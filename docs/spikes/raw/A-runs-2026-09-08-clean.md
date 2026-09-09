### wasm / q8

- device: Microphone (Arozzi Sfera Pro Microphone) (0d8c:016c) at 48000 Hz, graph 16000 Hz
- load: TTS 1168 ms, STT 1399 ms
- JS heap after: 19 MB
- turns: 10 (0 incomplete)
- **end of speech to first audio: median 4397 ms, worst 4661 ms**
- of which hangover 512 ms, STT 104 ms, TTS 3779 ms (medians)

| # | transcript | end→audio | hangover | STT | TTS |
|---|---|---|---|---|---|
| 1 | What's the weather like today? | 4661 | 512 | 207 | 3942 |
| 2 | What time will Alice be home? | 4458 | 512 | 135 | 3812 |
| 3 | Who owns that silver car? | 4410 | 512 | 114 | 3784 |
| 4 | What color is that cat? | 3861 | 512 | 85 | 3264 |
| 5 | What's the weather like today? | 4415 | 512 | 108 | 3795 |
| 6 | What time will Alice be home? | 4405 | 512 | 100 | 3793 |
| 7 | Who owns that silver car? | 4325 | 512 | 105 | 3708 |
| 8 | What color is that cat? | 3866 | 512 | 83 | 3271 |
| 9 | What's the weather like today? | 4389 | 512 | 103 | 3774 |
| 10 | What time will Alice be home? | 4351 | 512 | 96 | 3743 |

VAD state shape [2,1,128]
VAD ready
TTS ready in 1168 ms
STT ready in 1399 ms
Mic: Microphone (Arozzi Sfera Pro Microphone) (0d8c:016c) at 48000 Hz, graph at 16000 Hz
utterance 38912 samples = 2432 ms, rms 0.050, peak 0.398, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 51600 samples
utterance 39936 samples = 2496 ms, rms 0.046, peak 0.488, max p(speech) 0.99
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 41984 samples = 2624 ms, rms 0.056, peak 0.394, max p(speech) 0.98
transcript: "Who owns that silver car?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 35328 samples = 2208 ms, rms 0.062, peak 0.490, max p(speech) 0.99
transcript: "What color is that cat?" — asking for synthesis
TTS chunk 0, 44400 samples
utterance 38400 samples = 2400 ms, rms 0.054, peak 0.444, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 51600 samples
utterance 39936 samples = 2496 ms, rms 0.044, peak 0.392, max p(speech) 0.99
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 40448 samples = 2528 ms, rms 0.060, peak 0.438, max p(speech) 0.99
transcript: "Who owns that silver car?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 35840 samples = 2240 ms, rms 0.065, peak 0.521, max p(speech) 1.00
transcript: "What color is that cat?" — asking for synthesis
TTS chunk 0, 44400 samples
utterance 36352 samples = 2272 ms, rms 0.058, peak 0.470, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 51600 samples
utterance 39424 samples = 2464 ms, rms 0.050, peak 0.442, max p(speech) 1.00
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples

--
### webgpu / fp32

- device: Microphone (Arozzi Sfera Pro Microphone) (0d8c:016c) at 48000 Hz, graph 16000 Hz
- load: STT 1681 ms, TTS 1639 ms
- JS heap after: 17 MB
- turns: 10 (0 incomplete)
- **end of speech to first audio: median 947 ms, worst 1225 ms**
- of which hangover 512 ms, STT 180 ms, TTS 245 ms (medians)

| # | transcript | end→audio | hangover | STT | TTS |
|---|---|---|---|---|---|
| 1 | What's the weather like today? | 1225 | 512 | 300 | 413 |
| 2 | What time will Alice be home? | 958 | 512 | 177 | 269 |
| 3 | Who owns a silver car? | 1097 | 512 | 191 | 394 |
| 4 | What color is that cat? | 947 | 512 | 202 | 233 |
| 5 | What's the weather like today? | 947 | 512 | 180 | 255 |
| 6 | What time will Alice be home? | 905 | 512 | 169 | 224 |
| 7 | Who owns that silver car? | 899 | 512 | 152 | 235 |
| 8 | What color is that cat? | 867 | 512 | 148 | 207 |
| 9 | What's the weather like today? | 947 | 512 | 181 | 255 |
| 10 | What time will Alice be home? | 953 | 512 | 210 | 231 |

VAD state shape [2,1,128]
VAD ready
STT ready in 1681 ms
TTS ready in 1639 ms
Mic: Microphone (Arozzi Sfera Pro Microphone) (0d8c:016c) at 48000 Hz, graph at 16000 Hz
utterance 37376 samples = 2336 ms, rms 0.043, peak 0.332, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 50400 samples
utterance 38400 samples = 2400 ms, rms 0.057, peak 0.625, max p(speech) 1.00
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 40448 samples = 2528 ms, rms 0.071, peak 0.444, max p(speech) 0.99
transcript: "Who owns a silver car?" — asking for synthesis
TTS chunk 0, 47400 samples
utterance 38400 samples = 2400 ms, rms 0.071, peak 0.609, max p(speech) 1.00
transcript: "What color is that cat?" — asking for synthesis
TTS chunk 0, 45000 samples
utterance 36864 samples = 2304 ms, rms 0.059, peak 0.510, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 50400 samples
utterance 39424 samples = 2464 ms, rms 0.059, peak 0.561, max p(speech) 1.00
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples
utterance 42496 samples = 2656 ms, rms 0.060, peak 0.422, max p(speech) 1.00
transcript: "Who owns that silver car?" — asking for synthesis
TTS chunk 0, 51600 samples
utterance 37376 samples = 2336 ms, rms 0.050, peak 0.385, max p(speech) 1.00
transcript: "What color is that cat?" — asking for synthesis
TTS chunk 0, 45000 samples
utterance 34816 samples = 2176 ms, rms 0.059, peak 0.462, max p(speech) 1.00
transcript: "What's the weather like today?" — asking for synthesis
TTS chunk 0, 50400 samples
utterance 38912 samples = 2432 ms, rms 0.054, peak 0.530, max p(speech) 1.00
transcript: "What time will Alice be home?" — asking for synthesis
TTS chunk 0, 51000 samples

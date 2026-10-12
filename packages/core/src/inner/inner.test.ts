import type { CancellationSignal, ConversationEvent, LLMProvider, LlmRequest, LlmStreamChunk } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { ChatSession } from '../chat/session';
import { ConversationMachine } from '../conversation/machine';
import { ManualSink, ScriptedTTS, settle } from '../testing/scripted';
import { emptyTranscript, reduceTranscript } from '../transcript/transcript';
import { INNER_KEEP, INNER_MARKER, attachInnerMonologue, innerMessages, parseInnerLines, repeatsAnswer } from './monologue';
import { InlineThinking, withThinking } from './thinking';

/** One script per request, and every request kept. */
class Scripted implements LLMProvider {
  readonly id = 'scripted';
  readonly requests: LlmRequest[] = [];
  private readonly scripts: (readonly LlmStreamChunk[])[];
  constructor(scripts: (readonly LlmStreamChunk[])[]) {
    this.scripts = scripts;
  }
  async listModels(): Promise<never[]> {
    return [];
  }
  async *stream(request: LlmRequest, options?: { signal?: CancellationSignal }): AsyncIterable<LlmStreamChunk> {
    this.requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
    for (const chunk of this.scripts[this.requests.length - 1] ?? []) {
      if (options?.signal?.aborted === true) return;
      yield chunk;
    }
  }
}

const think = (text: string): LlmStreamChunk => ({ type: 'reasoning-delta', text });
const say = (text: string): LlmStreamChunk => ({ type: 'text-delta', text });
const FINISH: LlmStreamChunk = { type: 'finish', reason: 'stop', usage: null };
const ALICE = { name: 'Alice', summary: 'Alice is curious and warm.' };

async function drain(llm: LLMProvider): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const chunk of llm.stream({ modelId: 'm', messages: [], tools: [], temperature: null, maxOutputTokens: null })) out.push(chunk);
  return out;
}

describe('InlineThinking', () => {
  it('takes <think> out of the words, a tag split anywhere across deltas', () => {
    const whole = 'Hi. <think>they seem tired</think>How was it?';
    for (let cut = 1; cut < whole.length; cut += 1) {
      for (let second = cut + 1; second < whole.length; second += 1) {
        const split = new InlineThinking();
        const parts = [split.push(whole.slice(0, cut)), split.push(whole.slice(cut, second)), split.push(whole.slice(second)), split.flush()];
        expect(parts.map((part) => part.text).join(''), `${cut}/${second}`).toBe('Hi. How was it?');
        expect(parts.map((part) => part.reasoning).join('')).toBe('they seem tired');
      }
    }
  });

  it('leaves text that only looks like a tag, and keeps an unclosed think as thinking', () => {
    const split = new InlineThinking();
    expect(split.push('I <3 that. <thi')).toEqual({ text: 'I <3 that. ', reasoning: '' });
    expect(split.push('ng> no')).toEqual({ text: '<thing> no', reasoning: '' });
    const open = new InlineThinking();
    expect(open.push('<THINK>still going')).toEqual({ text: '', reasoning: 'still going' });
    expect(open.flush()).toEqual({ text: '', reasoning: '' });
  });
});

describe('withThinking', () => {
  it('hands reasoning to the sink, moves inline thinking there too, and leaves the words alone', async () => {
    const heard: string[] = [];
    const llm = withThinking(new Scripted([[think('plan: '), think('be brief'), say('Sure <thi'), say('nk>check the dates</think>thing.'), FINISH]]), (text) => heard.push(text));
    const chunks = await drain(llm);
    expect(heard.join('')).toBe('plan: be briefcheck the dates');
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')).toBe('Sure thing.');
    expect(chunks.at(-1)).toEqual(FINISH);
  });

  it('lets out a held-back "<" before the answer finishes', async () => {
    const chunks = await drain(withThinking(new Scripted([[say('a <'), FINISH]]), () => undefined));
    expect(chunks).toEqual([say('a '), say('<'), FINISH]);
  });
});

function rig(answers: (readonly LlmStreamChunk[])[], inner: (readonly LlmStreamChunk[])[] = []) {
  const machine = new ConversationMachine({ sessionId: 'c', characterId: 'alice', now: () => '2026-10-12T18:00:00.000Z' });
  const events: ConversationEvent[] = [];
  machine.subscribe((event) => events.push(event));
  const model = new Scripted(answers);
  const innerModel = new Scripted(inner);
  const monologue = attachInnerMonologue(machine, { llm: innerModel, modelId: 'm', character: ALICE, now: () => new Date('2026-10-12T18:00:00Z') });
  const chat = new ChatSession({ sessionId: 'c', machine, llm: withThinking(model, (text) => monologue.hear(text)), modelId: 'm' });
  machine.start();
  return { machine, events, model, innerModel, monologue, chat };
}

/** Everything that went on the bus, as one string to search. */
const busText = (events: readonly ConversationEvent[]): string => JSON.stringify(events);

describe('the inner monologue (P6-T05 done-when: never spoken)', () => {
  it('a spoken answer: her reasoning and her private lines never reach the voice, the transcript, the bus or the next request', async () => {
    const r = rig(
      [
        [think('SECRET-PLAN: the user is tired, keep it short. '), say('<think>HIDDEN-THOUGHT</think>'), say('Long day? '), say('Sit down a minute.'), FINISH],
        [say('Okay.'), FINISH],
      ],
      [[say('They sound worn out, PRIVATE-LINE.\nI want to ask about it later.'), FINISH]],
    );
    const tts = new ScriptedTTS();
    const sink = new ManualSink();
    r.chat.setVoice({ tts, sink, voiceId: 'af_heart' });
    r.monologue.look(true);
    r.chat.send('long day');
    await settle();
    sink.start(100);
    sink.end(100);
    sink.start(101);
    sink.end(101);
    await settle();

    expect(tts.requests.map((request) => request.text)).toEqual(['Long day?', 'Sit down a minute.']);
    const moment = r.monologue.moments().at(-1);
    expect(moment).toMatchObject({ heard: 'long day', said: 'Long day? Sit down a minute.', state: 'ready' });
    expect(moment?.reasoning).toBe('SECRET-PLAN: the user is tired, keep it short. HIDDEN-THOUGHT');
    expect(moment?.lines).toEqual(['They sound worn out, PRIVATE-LINE.', 'I want to ask about it later.']);

    r.chat.send('yes');
    await settle();
    const next = JSON.stringify(r.model.requests[1]?.messages);
    for (const secret of ['SECRET-PLAN', 'HIDDEN-THOUGHT', 'PRIVATE-LINE']) {
      expect(tts.requests.some((request) => request.text.includes(secret)), secret).toBe(false);
      expect(busText(r.events), secret).not.toContain(secret);
      expect(next, secret).not.toContain(secret);
    }
    expect(r.events.reduce(reduceTranscript, emptyTranscript()).lines.map((line) => ('text' in line ? line.text : ''))).toEqual(['long day', 'Long day? Sit down a minute.', 'yes', 'Okay.']);
  });

  it('asks nothing while the panel is closed; opening it puts the newest moment into words, and each one after', async () => {
    const r = rig(
      [
        [think('a'), say('One.'), FINISH],
        [say('Two.'), FINISH],
        [say('Three.'), FINISH],
      ],
      [
        [say('About two.'), FINISH],
        [say('About three.'), FINISH],
      ],
    );
    r.chat.send('first');
    await settle();
    r.chat.send('second');
    await settle();
    expect(r.innerModel.requests).toHaveLength(0);
    expect(r.monologue.moments().map((moment) => moment.state)).toEqual(['unread', 'unread']);

    r.monologue.look(true);
    await settle();
    expect(r.monologue.moments().map((moment) => [moment.said, moment.state, moment.lines])).toEqual([
      ['One.', 'unread', []],
      ['Two.', 'ready', ['About two.']],
    ]);
    r.chat.send('third');
    await settle();
    expect(r.monologue.moments().at(-1)?.lines).toEqual(['About three.']);

    // Asked as ADR-37's side calls are: reasoning off, no tools, with who she is.
    const request = r.innerModel.requests[0];
    expect(request).toMatchObject({ reasoning: 'off', tools: [] });
    expect(request?.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining(INNER_MARKER) as unknown });
    expect(JSON.stringify(request?.messages)).toContain('Alice is curious and warm.');

    r.monologue.look(false);
    r.chat.send('fourth');
    await settle();
    expect(r.innerModel.requests).toHaveLength(2);
  });

  it('an opener is a moment she began; an answer stopped before a word is none; a model that says nothing fails quietly', async () => {
    const r = rig([[say('Evening!'), FINISH], []], [[say('the user wants dates'), FINISH]]);
    r.monologue.look(true);
    expect(r.chat.open()).toBe(true);
    await settle();
    expect(r.monologue.moments()).toEqual([expect.objectContaining({ heard: null, said: 'Evening!', state: 'failed', lines: [] })]);
    expect(r.innerModel.requests[0]?.messages[1]).toMatchObject({ content: expect.stringContaining('You spoke first: Evening!') as unknown });
    r.chat.send('hi');
    await settle();
    expect(r.monologue.moments()).toHaveLength(1);
  });

  it('keeps the newest few moments, and stops asking once detached', async () => {
    const answers = Array.from({ length: INNER_KEEP + 2 }, (_, i) => [say(`Answer ${i}.`), FINISH]);
    const r = rig(answers);
    for (let i = 0; i < INNER_KEEP + 2; i += 1) {
      r.chat.send(`q${i}`);
      await settle();
    }
    expect(r.monologue.moments()).toHaveLength(INNER_KEEP);
    expect(r.monologue.moments()[0]?.said).toBe('Answer 2.');
    r.monologue.detach();
    r.monologue.look(true);
    await settle();
    expect(r.innerModel.requests).toHaveLength(0);
  });
});

describe('her lines', () => {
  it('come out as lines: bullets, quotes and a reasoning-voice "Okay," off; meta and her answer again dropped; three at most', () => {
    const said = 'Of course I do, you have a DJI Neo and want to fly it by the water.';
    expect(
      parseInnerLines(
        [
          '- "They sounded like they were testing me."',
          '2) okay, i hope I got it right',
          'The user seems anxious.',
          'Thoughts:',
          'You have a DJI Neo and want to fly it by the water.',
          '<br>',
          'I want to ask about the footage.',
          'One too many.',
        ].join('\n'),
        said,
      ),
    ).toEqual(['They sounded like they were testing me.', 'I hope I got it right', 'I want to ask about the footage.']);
  });

  it('take a paragraph a sentence at a time, and drop thinking written into the reply', () => {
    const paragraph = `${'They went quiet after that, and I think it landed harder than they let on. '.repeat(4)}I'll wait.`;
    const lines = parseInnerLines(`<think>draft</think>${paragraph}`);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('They went quiet after that, and I think it landed harder than they let on.');
  });

  it('count six words in a row from her answer as the answer again', () => {
    expect(repeatsAnswer('I said you have a DJI Neo drone there', 'You have a DJI Neo drone, right?')).toBe(true);
    expect(repeatsAnswer('I hope the drone thing goes well', 'You have a DJI Neo drone, right?')).toBe(false);
  });

  it('are asked for with what was said, her reasoning if any, and "they" said last', () => {
    const messages = innerMessages(ALICE, { heard: 'hi', said: 'Hey.', reasoning: '' });
    expect(messages[1]?.content).toBe('They said: hi\n\nYou answered: Hey.\n\nNow your private thoughts — and they are "they".');
    expect(innerMessages(ALICE, { heard: 'hi', said: 'Hey.', reasoning: 'greet back' })[1]?.content).toContain('Your reasoning before you answered');
  });
});

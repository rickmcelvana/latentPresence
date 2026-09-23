import { describe, expect, it } from 'vitest';
import { ConversationStateSchema } from '@latentpresence/protocol';
import { BASE_CROSSFADE_MS, BaseClipGraph, STATE_CLIPS } from './graph';

describe('BaseClipGraph', () => {
  it('has a clip for every conversation state', () => {
    for (const state of ConversationStateSchema.options) expect(STATE_CLIPS[state]).toBeDefined();
  });

  it('starts with no crossfade, then crossfades under the plan’s 300 ms on a change', () => {
    const graph = new BaseClipGraph();
    expect(graph.setState('listening')).toEqual({ clip: 'idle', crossfadeMs: 0 });
    expect(graph.setState('speaking')).toEqual({ clip: 'talk', crossfadeMs: BASE_CROSSFADE_MS });
    expect(BASE_CROSSFADE_MS).toBeLessThan(300);
  });

  it('says nothing when the clip would not change, so a loop is never restarted mid-cycle', () => {
    // listening → thinking → interrupted are all idle: a second `play('idle')` would reset
    // the action to frame 0 and snap the body — the pop the crossfade exists to prevent.
    const graph = new BaseClipGraph();
    graph.setState('listening');
    expect(graph.setState('thinking')).toBeNull();
    graph.setState('speaking');
    expect(graph.setState('speaking')).toBeNull();
    expect(graph.setState('interrupted')).toEqual({ clip: 'idle', crossfadeMs: BASE_CROSSFADE_MS });
  });

  it('answers again after a reset, with no crossfade', () => {
    const graph = new BaseClipGraph();
    graph.setState('speaking');
    graph.reset();
    expect(graph.setState('speaking')).toEqual({ clip: 'talk', crossfadeMs: 0 });
  });
});

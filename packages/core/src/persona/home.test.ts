import alice from '../../../../personas/alice.persona.json' with { type: 'json' };
import { PersonaSchema } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { HA_ASSIST_PROMPT } from '../tools/fixtures/ha-assist-prompt';
import { parseHomeOverview } from '../tools/home';
import { HOME_PROMPT_DEVICES, homeContext, renderHome } from './home';
import { renderSystemPrompt } from './prompt';

const devices = parseHomeOverview(HA_ASSIST_PROMPT);

describe('the home section (P5-T07, ADR-48)', () => {
  it('lists the devices by area with their domains, and the room they talk from', () => {
    const text = renderHome({ devices, area: 'Kitchen' }).join('\n');
    expect(text).toContain('THEIR HOME');
    expect(text).toContain('- They are talking to you from the Kitchen. "The light" or "in here" means the Kitchen\'s.');
    expect(text).toContain('  Kitchen: Kitchen Lights (light), Kitchen Window (cover)');
    expect(text).toContain('  Garage: Garage Door (cover)');
    expect(text).toContain('  No area: AC (switch), ');
    expect(text.indexOf('  Bedroom:')).toBeLessThan(text.indexOf('  Garage:'));
  });

  it('says nothing about a room when none is set, and points past a long list to GetLiveContext', () => {
    expect(renderHome({ devices, area: null }).join('\n')).not.toContain('talking to you from');
    const many = Array.from({ length: HOME_PROMPT_DEVICES + 3 }, (_, i) => ({ names: [`Lamp ${i}`], domain: 'light', areas: [] }));
    const text = renderHome({ devices: many, area: null }).join('\n');
    expect(text).toContain('Lamp 149 (light)');
    expect(text).not.toContain('Lamp 150 (light)');
    expect(text).toContain('And 3 more: GetLiveContext finds them');
  });

  it('is in the system prompt only when there is a home', () => {
    const persona = PersonaSchema.parse(alice);
    const now = new Date(2026, 9, 11, 9, 0);
    expect(renderSystemPrompt(persona, { now })).not.toContain('THEIR HOME');
    expect(renderSystemPrompt(persona, { now, home: homeContext(devices, null) })).toContain('THEIR HOME');
  });
});

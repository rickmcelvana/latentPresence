import { useState, type ReactElement } from 'react';
import { repeatWords, type ScheduleRequest, type ScheduleResult } from '@latentpresence/core';
import type { PluginManifest } from '@latentpresence/protocol';
import type { Characters } from '../characters/packs';
import type { CompanionConfigApi } from '../desktop/companion-config';
import type { Settings } from '../settings/settings';
import { ADDED, DECLINED, pluginOffers, pluginStdioName, presetRequest, withHttpServer, withOfferAnswer, type PluginOffer } from './offers';

/**
 * What a plugin offers beyond its own tools, under it in Settings → Plugins (P10-T07, ADR-72 item 7):
 * its MCP servers and schedule presets, each asked once, with Add / No thanks. A program (stdio) is
 * added only by the desktop shell, after its own dialog shows the whole command; in a browser there
 * is no companion that may start one, so it says so.
 */
export interface PluginOffersProps {
  readonly manifest: PluginManifest;
  readonly settings: Settings;
  readonly onChange: (update: (prev: Settings) => Settings) => void;
  /** The desktop shell's route to the companion's `mcp.json`; null in a browser. */
  readonly companion: CompanionConfigApi | null;
  /** Makes a schedule for a character through the ordinary store; null when memory is off. */
  readonly makeSchedule: ((characterId: string, request: ScheduleRequest) => Promise<ScheduleResult>) | null;
  /** Whose schedule an offer makes, by name (P11-T01). */
  readonly characters: Characters;
}

function describe(offer: PluginOffer, characters: Characters): { readonly title: string; readonly detail: string } {
  switch (offer.kind) {
    case 'http':
      return { title: `Server: ${offer.server.name}`, detail: `${offer.server.url}. Its tools join Settings → Tools, each asked about before it runs.` };
    case 'stdio':
      return {
        title: `Program: ${offer.server.name}`,
        detail: `${[offer.server.command, ...offer.server.args].join(' ')}. The companion would start it with your permissions.`,
      };
    case 'schedule': {
      const when = repeatWords(offer.preset.cron) ?? offer.preset.cron;
      return { title: `Schedule for ${characters.packFor(offer.characterId).persona.name}: ${offer.preset.description}`, detail: `${when.charAt(0).toUpperCase()}${when.slice(1)}.` };
    }
  }
}

function answered(offer: PluginOffer, answer: string): string {
  if (answer === DECLINED) return 'Not added.';
  return offer.kind === 'schedule' ? 'Made; it is in her Schedules.' : offer.kind === 'stdio' ? 'Added to the companion.' : 'Added to Settings → Tools.';
}

export function PluginOffers({ manifest, settings, onChange, companion, makeSchedule, characters }: PluginOffersProps): ReactElement | null {
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const enabledFor = Object.entries(settings.characters).flatMap(([id, character]) => (character.plugins.includes(manifest.id) ? [id] : []));
  const offers = pluginOffers(manifest, settings, enabledFor);
  if (offers.length === 0) return null;

  const decline = (offer: PluginOffer) => onChange((prev) => withOfferAnswer(prev, manifest.id, offer.key, DECLINED));

  const accept = async (offer: PluginOffer) => {
    setWorking(offer.key);
    setProblem(null);
    try {
      if (offer.kind === 'http') {
        const server = offer.server;
        onChange((prev) => withHttpServer(prev, manifest, server));
      } else if (offer.kind === 'stdio') {
        if (companion === null) return;
        const added = await companion.addPluginServer({
          plugin: manifest.id,
          pluginName: manifest.name,
          server: offer.server.id,
          serverName: offer.server.name,
          command: offer.server.command,
          args: offer.server.args,
        });
        // "Not now" in the shell's own dialog leaves the offer open: the person may still change their mind here.
        if (added !== null) onChange((prev) => withOfferAnswer({ ...prev, tools: { ...prev.tools, companion: true } }, manifest.id, offer.key, ADDED));
      } else {
        if (makeSchedule === null) return;
        const made = await makeSchedule(offer.characterId, presetRequest(manifest, offer.preset));
        if (made.ok) onChange((prev) => withOfferAnswer(prev, manifest.id, offer.key, made.schedule.id));
        else setProblem(made.reason);
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="plugin-offers">
      <p className="field-label">It also offers</p>
      <ul aria-label={`What ${manifest.name} offers`} className="plugin-offer-list">
        {offers.map(({ offer, answer }) => {
          const { title, detail } = describe(offer, characters);
          const blocked = offer.kind === 'stdio' && companion === null ? 'Only in the desktop app, where the companion may start programs.' : offer.kind === 'schedule' && makeSchedule === null ? 'Schedules are kept in her memory, which is off.' : null;
          return (
            <li className="plugin-offer" key={offer.key}>
              <span className="plugin-offer-title">{title}</span>
              <span className={offer.kind === 'stdio' ? 'field-hint plugin-mono plugin-facts-wrap' : 'field-hint'}>{detail}</span>
              {offer.kind === 'stdio' && answer === null ? <span className="field-hint">Named in the companion as {pluginStdioName(manifest.id, offer.server.id)}.</span> : null}
              {answer !== null ? (
                <span className="field-hint plugin-offer-answer">{answered(offer, answer)}</span>
              ) : blocked !== null ? (
                <span className="field-hint">{blocked}</span>
              ) : (
                <div className="plugin-offer-actions">
                  <button className="btn btn-primary" disabled={working !== null} onClick={() => void accept(offer)} type="button">
                    {offer.kind === 'schedule' ? 'Make it' : offer.kind === 'stdio' ? 'Add it…' : 'Add it'}
                  </button>
                  <button className="btn btn-ghost" disabled={working !== null} onClick={() => decline(offer)} type="button">
                    No thanks
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {problem === null ? null : (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

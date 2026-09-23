import type { ModelDescriptor } from '@latentpresence/protocol';
import { asrModel, kokoroModel, sileroVadModel, smartTurnModel } from '@latentpresence/ml-web';
import type { Settings } from '../settings/settings';

/**
 * Which browser models a spoken call needs, given what `/settings` has chosen (P1-T15).
 *
 * This is the list the consent screen (P1-T13) shows before anything is fetched, and it
 * must be exactly the set the call is about to build — no more (the screen would ask for
 * something nothing downloads) and no fewer (`requireConsent` would throw after the user
 * agreed, which reads as a broken button).
 *
 * **Turn detection is never optional.** Silero and Smart Turn are what make a pause a turn
 * — `TurnDetector` takes probabilities from the first and an answer from the second — and
 * neither has a server counterpart in this project. So they are in the list whichever
 * Voice and Hearing sources are chosen, including both server ones.
 *
 * Recognising and speaking are optional: a server for either removes its browser model
 * rather than adding one. The precisions are the ones measured and shipped — Kokoro
 * `fp32`, because every quantised build is refused on WebGPU (P1-T08), and recognition
 * `fp32`, because a quantised graph transcribes every utterance as the same sentence with
 * no error (ADR-20).
 */
export function browserModelsFor(settings: Pick<Settings, 'tts' | 'stt'>): ModelDescriptor[] {
  const models: ModelDescriptor[] = [sileroVadModel(), smartTurnModel('gpu')];
  if (settings.stt.kind === 'moonshine-browser' || settings.stt.kind === 'whisper-browser') {
    models.push(asrModel(settings.stt.model, 'fp32'));
  }
  models.push(...voiceModelsFor(settings));
  return dedupeById(models);
}

/**
 * What speaking typed replies needs (P2-T08): the voice and nothing else — no microphone,
 * so no turn models and no recogniser. Empty for a server voice, which downloads nothing.
 * The same rule as `browserModelsFor`: exactly what `buildTtsProvider` will build.
 */
export function voiceModelsFor(settings: Pick<Settings, 'tts'>): ModelDescriptor[] {
  return settings.tts.kind === 'kokoro-browser' ? [kokoroModel('fp32')] : [];
}

/** Consent is per `ModelDescriptor.id`, so the same model twice would be asked about
 * twice on screen. Nothing here produces a duplicate today; this keeps that true when a
 * third choice is added. */
function dedupeById(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

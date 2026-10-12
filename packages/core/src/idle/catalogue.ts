import type { CharacterEmotion, CharacterGesture, GazeTarget } from '@latentpresence/protocol';

/**
 * What she can do when nobody is talking (P6-T01, ADR-50): each activity says when it fits and
 * how her body does it, in the vocabulary the avatar already has.
 *
 * The fits are deliberately coarse — a range of pleasure, a range of energy, a weight per part
 * of the day, how long it must have been quiet — because the point is plausibility, not a model
 * of a person: no yawning ten seconds after hello, no dozing on a bright morning, no humming
 * when she is low.
 */

/** Things in the room she can look at (ADR-49's boards, P2-T05's window and desk). All behind her. */
export type IdleProp = 'window' | 'whiteboard' | 'screen' | 'desk';

/** Procedural moves the avatar performs as eased additive bone rotations. */
export type IdlePose = 'turn' | 'stretch' | 'sway' | 'sigh' | 'yawn' | 'shoulders' | 'doze';

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/** What kind of thing it is, for variety: two of a kind in a row are less likely. */
export type IdleKind = 'look' | 'body' | 'face' | 'rest';

/** How the body does it. Every field is optional; together they are one moment of her. */
export interface IdlePerform {
  /** Where she looks: an existing target, or a prop (a look over the shoulder). */
  readonly gaze?: GazeTarget | IdleProp;
  readonly gesture?: CharacterGesture;
  readonly emote?: CharacterEmotion;
  readonly pose?: IdlePose;
  /** The clip a later pack would give it; with none loaded the pose is procedural (ADR-50). */
  readonly clip?: string;
}

export interface IdleActivity {
  readonly id: string;
  /** For the log and the debug panel. */
  readonly label: string;
  readonly kind: IdleKind;
  /** How long it lasts, milliseconds. */
  readonly durationMs: readonly [number, number];
  readonly weight: number;
  /** Mood pleasure it fits, −1..1. */
  readonly pleasure: readonly [number, number];
  /** Energy it fits, 0..1. */
  readonly energy: readonly [number, number];
  /** Weight by part of the day; a missing part is 1, 0 rules it out. */
  readonly day?: Partial<Record<DayPart, number>>;
  /** It must have been quiet at least this long. */
  readonly afterMs: number;
  /** Longer than the planner's 10 minutes for things a body does rarely (a yawn, a stretch). */
  readonly cooldownMs?: number;
  /** A prop it is about, when that prop showing something makes it likelier (ADR-49). */
  readonly about?: 'whiteboard' | 'screen';
  readonly perform: IdlePerform;
}

const S = 1000;
const MIN = 60 * S;

export const IDLE_ACTIVITIES: readonly IdleActivity[] = [
  {
    id: 'window',
    label: 'looks out of the window',
    kind: 'look',
    durationMs: [6 * S, 14 * S],
    weight: 1.2,
    pleasure: [-1, 1],
    energy: [0, 1],
    day: { morning: 1.3, afternoon: 1.2, evening: 0.8, night: 0.4 },
    afterMs: 30 * S,
    perform: { gaze: 'window', pose: 'turn', clip: 'look-back' },
  },
  {
    id: 'whiteboard',
    label: 'reads over the plan on the whiteboard',
    kind: 'look',
    durationMs: [6 * S, 12 * S],
    weight: 0.5,
    pleasure: [-0.6, 1],
    energy: [0.2, 1],
    afterMs: 45 * S,
    about: 'whiteboard',
    perform: { gaze: 'whiteboard', pose: 'turn', gesture: 'think', clip: 'look-back' },
  },
  {
    id: 'screen',
    label: 'glances at what is on the screen',
    kind: 'look',
    durationMs: [4 * S, 9 * S],
    weight: 0.5,
    pleasure: [-1, 1],
    energy: [0.2, 1],
    afterMs: 30 * S,
    about: 'screen',
    perform: { gaze: 'screen', pose: 'turn', clip: 'look-back' },
  },
  {
    id: 'desk',
    label: 'looks over at the desk',
    kind: 'look',
    durationMs: [4 * S, 8 * S],
    weight: 0.7,
    pleasure: [-1, 1],
    energy: [0, 1],
    afterMs: 60 * S,
    perform: { gaze: 'desk', pose: 'turn', clip: 'look-back' },
  },
  {
    id: 'look-around',
    label: 'looks around the room',
    kind: 'look',
    durationMs: [5 * S, 10 * S],
    weight: 1,
    pleasure: [-1, 1],
    energy: [0.25, 1],
    afterMs: 20 * S,
    perform: { gaze: 'away', gesture: 'tilt-head' },
  },
  {
    id: 'hands',
    label: 'looks down at her hands',
    kind: 'look',
    durationMs: [5 * S, 11 * S],
    weight: 0.9,
    pleasure: [-1, 0.6],
    energy: [0, 0.7],
    afterMs: 30 * S,
    perform: { gaze: 'down' },
  },
  {
    id: 'thought',
    label: 'is lost in thought',
    kind: 'face',
    durationMs: [7 * S, 15 * S],
    weight: 1,
    pleasure: [-0.8, 0.8],
    energy: [0, 0.8],
    afterMs: 60 * S,
    perform: { gaze: 'away', gesture: 'think', emote: 'curiosity' },
  },
  {
    id: 'smile',
    label: 'smiles to herself at something',
    kind: 'face',
    durationMs: [3 * S, 6 * S],
    weight: 0.8,
    pleasure: [0.2, 1],
    energy: [0.2, 1],
    afterMs: 45 * S,
    perform: { gaze: 'down', emote: 'amusement' },
  },
  {
    id: 'hum',
    label: 'hums and sways a little',
    kind: 'body',
    durationMs: [8 * S, 16 * S],
    weight: 0.8,
    pleasure: [0.25, 1],
    energy: [0.4, 1],
    day: { night: 0.3 },
    afterMs: 90 * S,
    perform: { pose: 'sway', emote: 'joy', gaze: 'wander', clip: 'sway' },
  },
  {
    id: 'stretch',
    label: 'stretches',
    kind: 'body',
    durationMs: [4 * S, 6 * S],
    weight: 1,
    pleasure: [-0.6, 1],
    energy: [0.15, 0.9],
    day: { morning: 1.4, afternoon: 1, evening: 1, night: 0.6 },
    afterMs: 3 * MIN,
    cooldownMs: 15 * MIN,
    perform: { pose: 'stretch', emote: 'relief', clip: 'stretch' },
  },
  {
    id: 'shoulders',
    label: 'rolls her shoulders',
    kind: 'body',
    durationMs: [3 * S, 5 * S],
    weight: 0.7,
    pleasure: [-1, 1],
    energy: [0.1, 0.9],
    afterMs: 5 * MIN,
    perform: { pose: 'shoulders', clip: 'shoulder-roll' },
  },
  {
    id: 'sigh',
    label: 'sighs',
    kind: 'body',
    durationMs: [3 * S, 5 * S],
    weight: 0.8,
    pleasure: [-1, 0.1],
    energy: [0, 0.6],
    afterMs: 60 * S,
    cooldownMs: 12 * MIN,
    perform: { pose: 'sigh', gaze: 'down', emote: 'concern', clip: 'sigh' },
  },
  {
    id: 'yawn',
    label: 'yawns',
    kind: 'body',
    durationMs: [3 * S, 5 * S],
    weight: 1,
    pleasure: [-1, 1],
    energy: [0, 0.45],
    day: { morning: 0.3, afternoon: 0.6, evening: 1.2, night: 1.3 },
    afterMs: 5 * MIN,
    cooldownMs: 15 * MIN,
    perform: { pose: 'yawn', clip: 'yawn' },
  },
  {
    id: 'doze',
    label: 'drifts off for a moment',
    kind: 'rest',
    durationMs: [15 * S, 40 * S],
    weight: 1.2,
    pleasure: [-1, 1],
    energy: [0, 0.3],
    day: { morning: 0, afternoon: 0.4, evening: 1, night: 1.8 },
    afterMs: 15 * MIN,
    cooldownMs: 20 * MIN,
    perform: { pose: 'doze', gaze: 'down', clip: 'doze' },
  },
  {
    id: 'check-in',
    label: 'looks to the camera, in case they are back',
    kind: 'face',
    durationMs: [3 * S, 5 * S],
    weight: 0.7,
    pleasure: [-0.5, 1],
    energy: [0.2, 1],
    afterMs: 4 * MIN,
    perform: { gaze: 'user', emote: 'curiosity', gesture: 'tilt-head' },
  },
  {
    id: 'shrug-off',
    label: 'shrugs something off',
    kind: 'face',
    durationMs: [2 * S, 4 * S],
    weight: 0.5,
    pleasure: [-0.4, 0.6],
    energy: [0.3, 1],
    afterMs: 2 * MIN,
    perform: { gesture: 'shrug', emote: 'amusement', gaze: 'wander' },
  },
];

/** The part of the day an hour falls in, the person's own clock. */
export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

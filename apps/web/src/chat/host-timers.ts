import type { Scheduler } from '@latentpresence/core';

/**
 * Host timers for the conversation machine (P1-T08's `Scheduler` port), and the one reason
 * `/chat` needs them (P1-T15).
 *
 * **Without a scheduler *and* without an `audioOut` port, the machine never leaves
 * `interrupted`.** `startTeardownTimer` — which runs on entering `interrupted`, i.e. after
 * every barge-in and every typed Stop — first asks the port to fade, and only if there is
 * no port does it fall back to a timer. `/dev/voice` supplies the port (`/dev/voice`'s
 * machine is built with `ports: { audioOut: sink }`), and the scheduler is its second half;
 * `/chat` supplies neither, because the audio graph belongs to a call that may not exist.
 * So the timer is what returns the machine to `listening` 100 ms after a barge-in, and
 * without it the character's state — and P1-T15's own state pill — sticks on `interrupted`
 * for the life of the page.
 *
 * Nothing is lost by having no port here: the fade itself is not the machine's to perform.
 * `Reply.interrupt` calls the sink's `fadeOut` directly, on the same output the machine
 * would have asked, so the audio really does fade and the timer is measuring the right
 * thing rather than standing in for it.
 *
 * `idleTimeoutMs` is left at its default 0, so this introduces no other timer: the machine
 * still never ends a session by itself.
 */
export function hostTimers(): Scheduler {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };
}

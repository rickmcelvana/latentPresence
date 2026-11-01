// P9-T03 (ADR-69): before zod loads. zod decides whether it may compile its validators with
// `new Function` by trying it once, when the first object schema is built (at module load), and
// under the page's Content Security Policy it never may, so the try only reports a violation.
// zod keeps a config it finds here (`globalThis.__zod_globalConfig`, zod 4.6.7). A classic
// script, so it runs before the deferred modules; a file of the app's own, so the policy allows it.
// oxlint-disable-next-line no-underscore-dangle -- the name is zod's, not ours
globalThis.__zod_globalConfig = { ...globalThis.__zod_globalConfig, jitless: true };

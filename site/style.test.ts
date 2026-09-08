import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-15 for the static site: every class in the HTML has a rule in the one
 * stylesheet, and every rule in the stylesheet is used by some page. A class
 * with no rule renders unstyled; a rule with no class is dead weight copied from
 * a reference site that had sections we do not.
 */

// This file lives in site/, so the site root is its own directory.
const SITE = dirname(fileURLToPath(import.meta.url));

/** Every `.html` file under `site/`, recursively. */
function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

/** Every `.js` file under `site/`, recursively. */
function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/**
 * Class names a page applies from script rather than markup: `classList.add(...)`
 * and `className = '...'`.
 *
 * Without this the dead-rule test flags `.error`, `.success` and `.is-visible` —
 * rules doing real work, applied at runtime — and the only way to make it pass
 * would be to delete styling the site actually uses.
 */
function classesInScript(source: string): string[] {
  const found: string[] = [];
  const callSites = [
    /classList\.(?:add|remove|toggle)\(([^)]*)\)/g,
    /className\s*=\s*([^;]+);/g,
  ];
  for (const pattern of callSites) {
    for (const call of source.matchAll(pattern)) {
      for (const literal of (call[1] ?? '').matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
        const value = literal[1] ?? literal[2] ?? literal[3] ?? '';
        for (const token of value.split(/\s+/)) {
          if (/^[a-zA-Z][\w-]*$/.test(token)) found.push(token);
        }
      }
    }
  }
  return found;
}

/** Every class name the site asks for, in markup or from script. */
function classesUsedInSite(dir: string): Set<string> {
  const used = new Set<string>();
  for (const file of htmlFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      for (const token of (match[1] ?? '').split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(token)) used.add(token);
      }
    }
    // Inline <script> blocks live in the HTML, so the same source is scanned twice.
    for (const name of classesInScript(source)) used.add(name);
  }
  for (const file of jsFiles(dir)) {
    for (const name of classesInScript(readFileSync(file, 'utf8'))) used.add(name);
  }
  return used;
}

/**
 * Every class the stylesheet defines a rule for. Comments are stripped first: the
 * token block is documented in prose that names other sites, and `latentbeats.com`
 * would otherwise register as a rule for `.com`.
 */
function classesDefinedIn(css: string): Set<string> {
  const body = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...body.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1] ?? ''));
}

/** The part of a stylesheet a colour literal is not allowed in: not the comments,
 * and not the `:root` token blocks, which are the one place colours are declared. */
function styledBody(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/:root\s*\{[^}]*\}/g, '');
}

const cssPath = join(SITE, 'css', 'style.css');
const css = readFileSync(cssPath, 'utf8');
const defined = classesDefinedIn(css);
const used = classesUsedInSite(SITE);

describe('site/css/style.css covers every class in the HTML', () => {
  it('has a rule for every class used in a page', () => {
    const missing: string[] = [];
    for (const name of used) {
      if (!defined.has(name)) missing.push(`.${name}`);
    }
    expect(missing, 'add a rule to style.css for each missing class').toEqual([]);
  });

  it('has no rule that no page uses', () => {
    const dead: string[] = [];
    for (const name of defined) {
      if (!used.has(name)) dead.push(`.${name}`);
    }
    expect(dead, 'remove rules for sections this site does not have').toEqual([]);
  });
});

describe('feedback.js posts the exact API payload', () => {
  const jsPath = join(SITE, 'feedback', 'feedback.js');
  const js = readFileSync(jsPath, 'utf8');

  it('includes every required field and no extras', () => {
    const payloadMatch = js.match(/const payload = \{([\s\S]*?)\};/);
    expect(payloadMatch, 'payload object not found').toBeTruthy();

    const body = payloadMatch![1];
    const keys = [...body.matchAll(/^\s+([a-zA-Z_][\w]*):/gm)].map((m) => m[1]);
    expect(keys).toEqual([
      'source',
      'kind',
      'message',
      'email',
      '_hp',
      'user_agent',
      'screen_width',
      'screen_height',
    ]);
  });

  it('sets source to presence', () => {
    expect(js).toContain("source: 'presence'");
  });
});

describe('every page links the required assets and sets a description', () => {
  const required = {
    stylesheet: /<link[^>]*\srel="stylesheet"[^>]*\shref="[^"]*css\/style\.css"/,
    manifest: /<link[^>]*\srel="manifest"[^>]*\shref="[^"]*site\.webmanifest"/,
    svgIcon: /<link[^>]*\srel="icon"[^>]*\stype="image\/svg\+xml"/,
    pngIcon: /<link[^>]*\srel="icon"[^>]*\stype="image\/png"/,
    appleIcon: /<link[^>]*\srel="apple-touch-icon"/,
    description: /<meta[^>]*\sname="description"[^>]*\scontent="/,
  };

  for (const file of htmlFiles(SITE)) {
    const rel = relative(SITE, file);
    const source = readFileSync(file, 'utf8');

    it(`${rel} links a stylesheet, manifest and favicons, and sets a description`, () => {
      for (const [label, pattern] of Object.entries(required)) {
        expect(source, `missing ${label}`).toMatch(pattern);
      }
    });

    it(`${rel} references files that exist on disk`, () => {
      const pageDir = dirname(file);
      for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const raw = match[1] ?? '';
        // Skip absolute URLs, protocol-relative URLs, anchors and mailto links.
        if (/^(https?:|mailto:|#|\/\/)/.test(raw)) continue;
        // A fragment or query is not part of the path on disk: `../#features` is a
        // link to the landing page's Features section, not to a file called `#features`.
        const path = raw.replace(/[#?].*$/, '');
        if (path === '') continue;
        const target = resolve(pageDir, path);
        expect(existsSync(target), `broken reference: ${raw} in ${rel}`).toBe(true);
      }
    });
  }
});

describe('sitemap.xml lists the right pages', () => {
  const sitemap = readFileSync(join(SITE, 'sitemap.xml'), 'utf8');

  it('lists every page that is not noindex', () => {
    for (const file of htmlFiles(SITE)) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('noindex')) continue;
      const rel = relative(SITE, file).replace(/index\.html$/, '').replace(/\\/g, '/');
      const url = `https://latentpresence.com/${rel}`;
      expect(sitemap, `missing sitemap entry for ${rel}`).toContain(`<loc>${url}</loc>`);
    }
  });

  it('lists nothing that is noindex', () => {
    for (const file of htmlFiles(SITE)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('noindex')) continue;
      const rel = relative(SITE, file).replace(/index\.html$/, '').replace(/\\/g, '/');
      const url = `https://latentpresence.com/${rel}`;
      expect(sitemap, `sitemap contains noindex page ${rel}`).not.toContain(`<loc>${url}</loc>`);
    }
  });
});

describe('colours live only in :root', () => {
  /**
   * ADR-15: the site uses the same tokens as the app, and a literal outside the token
   * block is a colour that cannot be retuned with the rest of the palette. The Aider
   * run left four, one of which was a red (#f87171) close to but not the same as the
   * suite's --danger, which is exactly how a palette drifts.
   *
   * Same matcher as apps/web/src/theme.test.ts. Comments are stripped first, because
   * the token block is documented in prose that names colours in words.
   */
  const forbidden: readonly { label: string; pattern: RegExp }[] = [
    { label: 'hex colour', pattern: /#[0-9a-fA-F]{3,8}\b/g },
    { label: 'rgb()', pattern: /\brgba?\(/g },
    { label: 'hsl()', pattern: /\bhsla?\(/g },
    {
      label: 'named colour',
      pattern:
        /:\s*[^;{}]*\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|magenta|silver|gold|teal|navy|lime|olive|maroon|aqua|fuchsia)\b/g,
    },
  ];

  it('finds no colour literal outside a :root block', () => {
    const offences: string[] = [];
    const body = styledBody(css);
    for (const { label, pattern } of forbidden) {
      for (const match of body.matchAll(pattern)) {
        offences.push(`${label} "${match[0].trim()}"`);
      }
    }
    expect(offences, 'move the colour into a :root token and reference it with var()').toEqual([]);
  });

  it('would catch one if it appeared', () => {
    const bad = [
      ':root { --accent: #2dd4bf; }',
      '.btn { color: #ff0000; background: rgb(1, 2, 3); }',
      '.pill { border-color: hsl(0, 100%, 50%); outline-color: white; }',
    ].join('\n');
    const body = styledBody(bad);
    expect(body).not.toContain('--accent');
    for (const { label, pattern } of forbidden) {
      expect(new RegExp(pattern.source).test(body), label).toBe(true);
    }
  });
});

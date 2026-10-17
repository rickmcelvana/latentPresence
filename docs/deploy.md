# Deploying the app — `app.latentpresence.com`

How the hosted app is built and served. Rick's server runs Caddy; this page is the whole recipe.
Written 2026-10-16 from the first deploy. Each fact below was found by a failure, and the failures
are recorded under "Why" so nobody has to find them again.

The product site, `latentpresence.com`, is not in this repository any more (2026-10-17); this
page is about the app alone.

The app is static files: `apps/web/dist` after a build. There is no server-side code. Models,
the character and the person's data never touch this server: the page downloads models from
Hugging Face and the character from GitHub into the visitor's browser, and talks to *their*
Ollama, LM Studio or companion on their own machine.

## 1. Once, on the server

- **Node.js 22 or later** (`package.json` `engines`) and **pnpm 12.3.4**: `npm install -g pnpm@12.3.4`.
- **Git LFS.** The body's base clips (`assets/clips/idle.vrma`, `talk.vrma`) live in LFS. Without
  it the clone holds ~130-byte pointer files, the build bundles those, and nothing fails visibly:
  she just stands in her rest pose instead of idling and talking.

  ```bash
  sudo apt install git-lfs && git lfs install
  ```

## 2. Build, and every update

```bash
git pull && git lfs pull && pnpm install && pnpm build
```

Check the clips are real files (idle about 92 KB, talk about 103 KB, not a few hundred bytes):

```bash
ls -la apps/web/dist/assets/*.vrma
```

## 3. Caddy

```
app.latentpresence.com {
    root * /path/to/latentPresence/apps/web/dist
    encode zstd gzip

    header {
        Cross-Origin-Opener-Policy same-origin
        Cross-Origin-Embedder-Policy credentialless
    }
    # Built files carry a content hash in their names, so they can be cached for good.
    @hashed path /assets/*
    header @hashed Cache-Control "public, max-age=31536000, immutable"

    # The app routes in the browser: /chat, /settings and the rest all serve index.html.
    try_files {path} /index.html
    file_server
}
```

```bash
sudo systemctl reload caddy
```

### Why each line

- **`try_files {path} /index.html`**: without it, `/` worked and every link (`/chat`, `/settings`)
  was a Caddy 404, because there is no file called `chat`.
- **COOP `same-origin` + COEP**: together they make the page *cross-origin isolated*, which gives
  it `SharedArrayBuffer` (and lets the speech runtimes use more than one thread). The dev server
  sends neither, so isolation is only ever on in production.
- **COEP must be `credentialless`, not `require-corp`.** Measured 2026-10-16 (`docs/SURFACE.md`):
  under `require-corp` the browser blocks every opaque (`no-cors`) request to a server that does
  not send `Cross-Origin-Resource-Policy`. The connection test in Settings uses exactly such a
  request to tell "the server refused this site" from "nothing is running there", so with
  `require-corp` an Ollama without `OLLAMA_ORIGINS` was reported as **"no server found"** instead
  of showing the steps to set it. `credentialless` keeps the page isolated and lets that request
  through (it is sent without cookies).

## 4. Check it

```bash
curl -sI https://app.latentpresence.com/chat | grep -i "^HTTP\|cross-origin"
```

Expect `200`, `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`. Then, in the browser console on the site,
`crossOriginIsolated` should be `true`.

## 5. What visitors need on their own machine

- **A language model they can reach.** A cloud key (Settings → Language model) needs nothing
  else. A local **Ollama** must allow this site: `OLLAMA_ORIGINS=https://app.latentpresence.com`,
  then restart Ollama. Settings → Language model → Test says so, with the steps for their OS,
  when it is missing. LM Studio needs "Enable CORS" turned on.
- **Chrome or Edge** for the voice: it needs WebGPU (ADR-20).
- Browsers will ask before letting a public site reach `localhost` (Chrome's local network
  access). How that prompt behaves, and the companion's pairing, are P8-T03; until it lands, a
  local Ollama with `OLLAMA_ORIGINS` set is the tested path.

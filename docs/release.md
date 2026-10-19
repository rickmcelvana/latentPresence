# Releasing the desktop app (P8-T04, ADR-66)

A `v*` tag builds the Windows installer in GitHub Actions (`.github/workflows/release.yml`), signs
it for the updater, and attaches the installer, its `.sig` and `latest.json` to a **draft**
release. Nothing reaches anyone until the draft is published: installed copies ask
`releases/latest/download/latest.json`, and a draft is never "latest".

The installer itself is **unsigned** for Windows (SmartScreen: "More info → Run anyway"). The
updater's signature is a different thing: the app checks every downloaded installer against the
public key built into it and refuses one that does not match.

## Once: the release key

The key signs every update. **Keep the private key and its password safe and backed up**: if
they are lost, installed copies can never update again and everyone has to reinstall by hand.

1. In a terminal in the checkout:

   ```bash
   pnpm --filter @latentpresence/desktop exec tauri signer generate -w "$HOME/.tauri/latentpresence-release.key"
   ```

   It asks for a password twice: choose a long one and keep it in your password manager. It
   writes `latentpresence-release.key` (private) and `latentpresence-release.key.pub` (public) in
   `%USERPROFILE%\.tauri\`.
2. Copy both files somewhere safe (the password manager's attachments, or an encrypted backup).
3. GitHub → the repository → Settings → Secrets and variables → Actions → **New repository
   secret**, twice:
   - `TAURI_SIGNING_PRIVATE_KEY`: the whole contents of `latentpresence-release.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password.
4. The **public** key goes into `apps/desktop/src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey` (the one line in `latentpresence-release.key.pub`). It is not a secret.
   Until it is there, Check for updates says "This build cannot update itself".

## Each release

1. Raise `version` in `apps/desktop/src-tauri/tauri.conf.json` (e.g. `0.2.0`). The updater only
   offers a version higher than the installed one.
2. Commit it, push, and wait for the gate.
3. Tag and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. Actions → **release** builds (the gate runs first, about 15 minutes). Then GitHub → Releases:
   the draft `latentPresence v0.2.0` should have `latentPresence_0.2.0_x64-setup.exe`, its `.sig`
   and `latest.json`. Write the notes (they are shown in the app before Install), then
   **Publish release**.
5. In an installed copy: Settings → This app → Check for updates → Install and restart.

A copy installed **before** the updater existed (0.1.0 from a local build) cannot update itself:
install the first release once by hand, and every later one arrives through Check for updates.

## The test channel

How P8-T04's done-when was checked on 2026-10-19, without the release key or GitHub. A test build
is the app under another name, address and key — never a switch in the real app:

1. `tauri signer generate --ci -p "" -w <scratch>/test.key`.
2. A config file per version with `identifier` `com.latentpresence.updatetest`, `productName`
   `latentPresence Update Test`, `version`, `bundle.createUpdaterArtifacts: true` and
   `plugins.updater` (`pubkey` = the test public key, `endpoints` = `http://127.0.0.1:8765/latest.json`,
   `dangerousInsecureTransportProtocol: true`).
3. Build each with `TAURI_SIGNING_PRIVATE_KEY` set to the test key:
   `pnpm --filter @latentpresence/desktop tauri build --config <file>`.
4. Serve the newer installer and a `latest.json` (`version`, `notes`, `pub_date`, and
   `platforms."windows-x86_64"` with `signature` = the `.sig` contents and `url`) on 8765; install
   the older one with `/S`; Check, Install.
5. Uninstall with `uninstall.exe /S` from `%LOCALAPPDATA%\latentPresence Update Test`, and delete
   `%LOCALAPPDATA%\com.latentpresence.updatetest`.

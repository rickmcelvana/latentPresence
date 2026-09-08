# The latentPresence mark

`mark.svg` is the master. The PNGs are generated from it — edit the SVG, then regenerate:

```bash
cd site/img && for s in 16 32 48 180 192 512; do pnpm dlx sharp-cli --input mark.svg --output "presence_${s}x${s}.png" resize $s $s; done
```

`sharp-cli` is fetched on demand and is not a dependency of this repo.

## What it is

A dark tile, one thin ring, and a flat geometric glyph in the app's accent — the same bones as the
other Latent app icons, so the suite reads as a family. Teal here (ADR-15), where latentCreate is
blue.

The glyph is a dot held between two arcs: something is here, and something is attending to it.
latentCreate's three bars say audio; these two arcs say presence. It is deliberately abstract, so it
does not collide with the speech-bubble and volume glyphs every other app already uses.

Colours are the ADR-15 tokens by value, since an SVG cannot read CSS custom properties: `#0a0e1a`
tile, `#2dd4bf` glyph, `#3a4a5c` ring. If the palette moves, these move with it.

## Notes

- Sizes exist for a reason: 16/32/48 are browser favicons, 180 is the Apple touch icon, 192 and 512
  are the web manifest. Do not add sizes nothing references.
- These are exempt from git LFS in `.gitattributes`. They are small, and a site that needs
  `git lfs pull` before it can be served is worse than a few kilobytes in the tree.
- The SVG is also served directly as a favicon; the PNGs are the fallback.

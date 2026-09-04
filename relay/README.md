# Astral Relay archive

This directory is the editable source for `astramusic.dev/relay/`. The generated GitHub Pages output lives in `docs/relay/`; do not hand-edit generated files.

## Wednesday and Saturday updates

1. In Relay Studio, use **Copy web JSON** after entering the rotation number and publication date.
2. Paste the copied object into the array in `rotations.json`.
3. Use **Save web artwork** and place the resulting `NNN.webp` in `assets/artwork/`.
4. Run `npm run check:relay` from the `astra-site` repository.
5. Review `/relay/` and the new `/relay/NNN/` page, then publish through the site's existing GitHub Pages workflow.

The build sorts by rotation number and treats the highest number as current. It validates unique numbers and dates, ISO dates, required metadata, safe artwork paths, artwork existence, and the generated Astra Signal payload before replacing `docs/relay/`.

Required record fields are `number`, `publishedOn`, `artist`, `title`, `durationSeconds`, and `artwork`. `featureLine`, `album`, and `releaseYear` are optional and disappear from the page when omitted. Signal URLs are generated at build time and should not be stored in `rotations.json`.

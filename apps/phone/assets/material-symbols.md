# Android Material symbols

Standard Android controls use Google's Material Symbols Rounded. The pinned SVG path data and semantic mappings live in `material-symbols.json`, from [google/material-design-icons](https://github.com/google/material-design-icons/tree/10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7/symbols/web). Original view boxes are retained because upstream contains both 24-unit and 960-unit artwork.

The artwork is Copyright Google and licensed under Apache-2.0. See `material-symbols-LICENSE`.

`Symbol` selects these paths only on Android. iOS retains its existing symbols. Ardia's app artwork, favicons and custom incognito eyes stay unchanged on both platforms.

The native Android vectors use the same pinned paths. After editing the manifest, run `node apps/phone/scripts/material-symbols.mjs`. Pass `--check` to verify the generated Kotlin without writing it.

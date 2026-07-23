# Before the next package

Things that are fine while developing but must be dealt with before the
extension is zipped up and shipped.

## Prune the unused fonts — **open**

`fonts/` currently holds the whole Google Fonts download of IBM Plex Sans: 44
`.ttf` files, ~10 MB. Exactly one of them is referenced, by the single
`@font-face` rule at the top of `styles.css`:

```
fonts/IBMPlexSans-VariableFont_wdth,wght.ttf     533 KB
```

That one file covers every weight the UI asks for (400–700) and the width axis,
so the static cuts (`-Regular`, `-SemiBold`, `-Bold`, …), the `_Condensed` /
`_SemiCondensed` families and every italic are all dead weight. Deleting
everything except the variable upright file drops the packaged extension by
about 95% and changes nothing on screen.

Kept for now only because the extra cuts are handy while the type scale is
still being tuned — e.g. `IBMPlexSans_Condensed-*` would be the obvious answer
if the fully zoomed-out week grid ever needs narrower day-head labels.

Check before deleting: `grep -ro "fonts/[^\")]*" styles.css calendar.html src/`
should list only the variable file.

## Italics — **note**

No `@font-face` rule covers italic, and nothing in the UI uses it. If italic
type is ever introduced, add `IBMPlexSans-Italic-VariableFont_wdth,wght.ttf`
with `font-style: italic` rather than letting the browser synthesise a slant.

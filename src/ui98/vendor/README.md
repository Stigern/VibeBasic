# Vendored third-party assets

- `98.css` v0.1.21 by Jordan Scales, MIT (`LICENSE-98.css.txt`). Copy of `dist/98.css` with two edits:
  the invalid `@media (not(hover)){...}` block (rejected by Lightning CSS minification in `vite build`)
  and the source-map comment are removed. https://github.com/jdan/98.css
- `ms_sans_serif*.woff/.woff2`: the "Pixelated MS Sans Serif" fonts shipped with 98.css. They are
  the FontStructions "MS Sans Serif" and "MS Sans Serif Bold" by "lou" (fontstruct.com), licensed
  under **CC BY-SA 3.0** (`LICENSE-font-*.txt`, `README-font-*.txt`). The font files must be
  redistributed together with these licence/readme files and stay under CC BY-SA 3.0; the rest of
  the application is not an adaptation of the font. To drop the font, delete the two `@font-face`
  rules at the top of `98.css`; `theme.css` falls back to `Tahoma, Geneva, sans-serif` 11px.

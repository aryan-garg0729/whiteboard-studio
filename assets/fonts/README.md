# Bundled faces

The Text tab offers these and nothing else. A whiteboard tool lives or dies on
having a few good handwriting faces, and system font enumeration cannot promise
one: a stock Ubuntu box has DejaVu, Liberation, Ubuntu and Nimbus, and not a
single script face among them. Shipping the set also means a project opened on
another machine writes in the face it was authored in.

Order in `fonts.json` is the order in the picker: handwriting first, since that
is what the tool is for. `hand` drives the "script" tag in the UI.

Several are variable fonts (`Caveat`, `Montserrat`, `OpenSans`,
`PlayfairDisplay`). opentype.js ignores `gvar` and draws the default instance,
which for all of these is the regular weight -- that is what we want, and it is
why the files are named for the family rather than a style.

Anything added here must survive `isUsable()` in `electron/fonts.js`: opentype.js
refuses a handful of otherwise fine Google faces (Roboto and Lora both throw
`lookupType: 6 substFormat: 2` out of GSUB), and a face that throws at layout
time is far worse than one that was never offered.

| Family | File | Source | Licence |
| --- | --- | --- | --- |
| Caveat | `Caveat.ttf` | google/fonts `ofl/caveat` | OFL 1.1 |
| Patrick Hand | `PatrickHand-Regular.ttf` | google/fonts `ofl/patrickhand` | OFL 1.1 |
| Indie Flower | `IndieFlower-Regular.ttf` | google/fonts `ofl/indieflower` | OFL 1.1 |
| Architects Daughter | `ArchitectsDaughter-Regular.ttf` | google/fonts `ofl/architectsdaughter` | OFL 1.1 |
| Permanent Marker | `PermanentMarker-Regular.ttf` | google/fonts `apache/permanentmarker` | Apache 2.0 |
| Montserrat | `Montserrat.ttf` | google/fonts `ofl/montserrat` | OFL 1.1 |
| Poppins | `Poppins.ttf` | google/fonts `ofl/poppins` | OFL 1.1 |
| Open Sans | `OpenSans.ttf` | google/fonts `ofl/opensans` | OFL 1.1 |
| Playfair Display | `PlayfairDisplay.ttf` | google/fonts `ofl/playfairdisplay` | OFL 1.1 |

`OFL.txt` is the SIL Open Font Licence 1.1 the OFL faces are released under;
each upstream directory carries its own copy with its own copyright line.
`LICENSE-Apache-2.0.txt` covers Permanent Marker.

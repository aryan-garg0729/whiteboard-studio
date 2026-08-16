# Worked example — alchemy.md → alchemy.json

Two pages traced from script to clips. Read this before storyboarding anything; it shows the judgement calls
that the style rules only describe.

Sources: `/home/aryan/Personal/yt/v3/examples/alchemy.md` and `examples/alchemy.json`.

## Page 1 — the cold open

Script paragraph 1, the first 115 words:

> Right now you're watching this on a screen that you probably think produces millions of colors. It doesn't.
> It only produces three... red, green, and blue. Your brain is the one mixing them together and inventing
> every other color you see. The screen isn't showing you reality, it's hacking your perception into building
> reality for you. And here's the wild part... you can do the exact same trick with almost anything. You can
> make something ordinary feel amazing, or something genuinely good feel cheap, without changing the thing
> itself at all. Rory Sutherland, in his book Alchemy, calls this intervention...

| t | dur | asset | anim | why |
| --- | --- | --- | --- | --- |
| 0.0 | 4.6 | `HandsLaptop.png` | inkPaint | "watching this on a screen" — the literal noun, drawn slowly as the opening image |
| 6.9 | 1.5 | `RGB.png` | **stencilPaint** | "red, green, and blue" — a colour swatch, not line art, so the stencil |
| 8.9 | 2.9 | `BrainTop.png` | inkPaint | "your brain is the one mixing them" |
| 12.1 | 4.0 | `CloudBubbleThinking.png` | inkPaint | container for the thought, drawn beside the brain |
| 16.1 | 1.1 | text `REALITY!` Indie Flower `#000000` | handwrite | what the brain is inventing — **hand face, because it is inside the bubble** |
| 18.2 | 0.6 | `DashedBox.png` | **appear.instant** | container, snapped in |
| 18.8 | 2.3 | text "You can do the\nexact same\ntrick with almost\nanything" Poppins `#3b076e` | handwrite | **quoted verbatim** from the script |
| 21.1 | 0.5 | `YellowStickyCutout.png` | **appear.fade** | second container |
| 21.6 | 6.6 | text "You can make something ordinary feel amazing…" Poppins `#ff2424` | handwrite | **quoted verbatim**, the thesis of the video |

Nine clips over 28s. Note what did *not* get a clip: "It doesn't." and "The screen isn't showing you
reality, it's hacking your perception" — the first is a beat of emphasis, the second is already carried by
the brain-and-bubble image on screen.

Note the two-container ending: the argument's two payload sentences each get a box and a colour, drawn back
to back, and they close the page.

## Page 4 — a numbered section

Script paragraphs 2–4. The section header paragraph merges forward into the Eurostar story.

> One. Perception is reality.
>
> In 2009, the Eurostar train was losing passengers to airlines… Engineers spent over eight billion dollars
> rebuilding the track just to cut the travel time by forty minutes.
>
> Here's the psychological version… Instead of asking how do we reduce the quantity of time, ask how do we
> improve the quality of it. For a tiny fraction of that budget, they could've installed Wi-Fi years earlier…
> or hired incredible staff to serve free champagne the entire ride. People wouldn't have wanted the train to
> go faster. They'd have wanted it to go slower.

| t | dur | asset | anim | why |
| --- | --- | --- | --- | --- |
| 37.6 | 0.4 | `RedRectangle.png` `scaleX 0.767` | inkPaint | **section banner**, top-left, first clip of the page |
| 38.7 | 2.0 | text `1. Perception is Reality` Poppins `#ffffff` | handwrite | the script's own "One." digitised |
| 40.7 | **9.0** | `Train.png` | inkPaint `readingOrder` | the anecdote's subject — the longest clip in the video, drawn across the whole Eurostar setup |
| 49.7 | 1.5 | `GreenSackDollar.png` | inkPaint | "eight billion dollars" |
| 51.2 | 1.3 | `GreenSackDollar.png` | inkPaint | …same asset again |
| 52.5 | 1.3 | `GreenSackDollar.png` | inkPaint | …and again. **Three sacks = a lot of money.** |
| 53.8 | 2.5 | `ClockAttention.png` | inkPaint | "cut the travel time by forty minutes" |
| 56.7 | 3.5 | `Peter…Thinking…_out.png` | inkPaint | "Here's the psychological version of that same question" |
| 60.7 | 1.4 | text "How do we reduce\nquantity of time?" Poppins `#ea0606` | **appear.fade** + **erase at 62.4** | the wrong question — appears, then is wiped |
| 63.8 | 2.4 | text "How do we improve\nquality of time?" Poppins `#00a83b` | handwrite | the right question, **written into the same spot**, red → green |
| 66.6 | 2.2 | `HandHoldingBagSack…_out.png` | inkPaint | "a tiny fraction of that budget" |
| 69.2 | 1.8 | `Wifi.png` | inkPaint | "installed Wi-Fi" |
| 71.0 | 4.0 | `LadyChampagne.png` | **stencilPaint** | "serve free champagne" |
| 75.5 | 0.6 | `RedRectangle.png` `scaleX 0.351 scaleY 1.759` | appear.fade | container, stretched tall for a four-line caption |
| 76.1 | 4.1 | text "People wouldn't have wanted the train to go faster / They'd have wanted it to go slower" `#ffffff` | handwrite | **quoted verbatim**, the section's payoff |

Fifteen clips over 45s. Things to copy:

- The **erase swap** at 60.7 → 63.8. The two captions sit at nearly the same coordinates
  (`-253,-260` and `-286,-257`) and the colour flips red to green. This is the only good use of erase.
- The **9-second train**. One long draw can hold a whole paragraph; not every sentence needs its own clip.
- Asset **repetition for quantity** (three dollar sacks at 49.7 / 51.2 / 52.5, each ~1.4s apart).
- The banner `RedRectangle` is squeezed horizontally (`scaleX 0.767`) for a one-line title and stretched
  vertically (`scaleY 1.759`) for a four-line one. Containers are elastic; artwork is not.

## Captions are quoted, not written

Of 34 text clips, 12 are a verbatim contiguous run of script words and the rest are the same sentence cut to
a headline. The rule splits by length:

**Long captions (8–20 words) are quoted exactly.** These carry the thesis and the viewer reads along:
- "You can do the exact same trick with almost anything"
- "People wouldn't have wanted the train to go faster / They'd have wanted it to go slower"
- "Rudeness itself became the entertainment"
- "FIXING PERCEPTION iS THE ACTUAL JOB !!"

**Short captions are the keyword or the figure, with numerals digitised:**

| Script | Caption |
| --- | --- |
| "ninety seven percent of first class letters" | `97%` |
| "most guesses landed somewhere between forty and eighty percent" | `Most gusses landed\nbetween 40 to 80% and \nNo one said 97%` |
| "ten known minutes than five unknown ones" | `People are happier waiting \n10 known minutes than \n5 unknown once` |
| "calls this intervention" | `INTERVENTION` |
| "five times two is ten" | `5` `x` `2` `10` — four separate one-character clips |
| "One. Perception is reality." | `1. Perception is Reality` |

So caption generation is **selection plus light compression, with spoken numbers turned into digits.** Quote
the script; do not paraphrase it. (The original's typos — `gusses`, `uncertainity`, `Once` for "ones" — are
the author's, not a convention to reproduce.)

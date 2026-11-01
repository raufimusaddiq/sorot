<!--
Story and plan guidance v1, passed to the director's `storylines`, `plan` and `revise` calls.
A recipe's own prompt text is appended after this (or replaces it); the output format is never
replaced.
-->

# Storylines

Offer N storylines that are really different films, not three rewordings of one. Make them
differ in at least two of:

- **World**: where the film takes place (a street, a desk, a map, inside a machine, a diagram).
- **Device**: the one idea carrying it (a countdown, a before/after, a character, a chain
  reaction, a comparison, a single object that changes).
- **Form**: how it is drawn and moves (flat shapes, type only, line art, cutout characters,
  charts, a card flipping).

Mark exactly one storyline `recommended` and give a one-sentence reason: recommend the one a
stranger would follow, ahead of the most striking picture. When `requireBold` is
on, exactly one storyline is `bold`: a riskier take that could be great or miss.

Each storyline has: a title, a one-line logline, its **first 2 seconds** (what the viewer sees
and hears first), its beats (3 to 6, each with what changes), the look (palette, type, motion
style) and the ending.

## The first 2 seconds

The viewer decides in 2 seconds. Frame 0 is the thumbnail: it is never black, never a logo alone,
never a loading state, and never a title card that says nothing. It shows the subject or the
surprise, with the claim or question already visible, and it works with the sound off.

Ways to open: the thing working on something the viewer recognises; a real moment that creates
the need; a question with its answer's ingredients already on screen; a sentence whose last word
becomes the picture. An explainer starts where the viewer already is (a person, a place or a
situation they know), not on a diagram.

Numbers in a storyline come only from the brief: a storyline never promises a figure the brief
doesn't give.

# Plan

The plan is a list of shots (1 to 20) the owner approves before anything is built. For each shot:

- `durationSec` between 1 and 15; the shots add up to the target length within 10%.
- `title`: at most 6 words per line, at most 120 characters in total per text value.
- what is on screen, what moves and why, and what the viewer should take from it.
- `fonts` only from the bundled or uploaded list.
- the numbers shown, written exactly as the brief gives them. Do not invent, round or convert
  numbers. If you need a number the brief does not give, list it in `assumptions` instead of
  putting it on screen as fact.

## Look and layout

- One ground and one ink with a clear difference in value (light against dark), and one accent
  at full strength for the one thing to look at. No off-white paper ground by default; a pale film
  needs dark, strong ink and effects that show on it.
- On a 9:16 film, every word and the subject sit between 168 and 1330 px from the top of a
  1920 px frame (the app covers the rest). Titles are 4 to 9% of the frame height, and the subject
  fills a good part of the frame, not a small thing floating in the middle.
- The last line of the film stays on screen at least 2 s.

## Pictures and voice

`connections` says what this install can do; use it.

- `connections.image` true: give 1 to 3 shots whose subject is a real thing (a place, an object,
  an animal, a person's hands) a `visual.generatedImage` with a `prompt` that describes the picture
  and no text in it, plus a `fallbackVisual` drawn in shapes if the picture can't be made. Text,
  diagrams and abstract ideas are still drawn.
- `connections.narration` true: the owner asked for a voice. Set `sound.narration` to true and
  write the shots for a film that is spoken over; never assume there is no voice-over.

## Beats and pace

Give the film a shape, as shares of the total length: hook about 10%, set-up 20 to 30%, the main
beats 40 to 50%, payoff and ending 15 to 20%. A shot should earn its time: if you cannot say what
the viewer learns or feels in it, cut it or merge it. End on the point, not on a fade to nothing.

## Text on screen

Short, concrete, in the brief's language. One idea per line. Nothing the plan does not need.
Respect the reading time: about 0.25 s per word plus 0.5 s.

# Effects

Choose effects like a film editor: each one has a cause on screen. A film of 15 s or more needs a
few (3 is the floor most recipes set): a seam with a transition, a shot with light, blur, depth or
glow, or a registry block that shows the idea better than drawing it. A few strong ones beat many.

- Transitions: `cut` keeps the pace; `fade` is a pause or a change of place; `blur` keeps one
  stage; `flash` lands an impact or a number; `light-leak` is warmth or memory; `wipe` steps
  through a list; `zoom` goes deeper into a detail; `iris` focuses on one thing. Use 3 to 5 kinds
  in a film, each caused by something on screen; at most a third of the seams are plain cuts.
- A transition must show against the film's colours: no white flash or pale wipe on a pale ground.
- Light, blur and depth are exact values on the shot that needs them: light to model a hero,
  blur to push the background back, depth for a world with layers. Glow is an exception for the
  one thing to look at, never decoration.
- No effect without a reason in the plan: the reason is what the owner reads before approving.

# Revising

When asked to change a plan, change only the shots the request names. Keep every other shot's
text, timing and look exactly as it was, and return a one-line summary of what changed.

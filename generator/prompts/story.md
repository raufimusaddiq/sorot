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

Mark exactly one storyline `recommended` and give a one-sentence reason. When `requireBold` is
on, exactly one storyline is `bold`: a riskier take that could be great or miss.

Each storyline has: a title, a one-line logline, its **first 2 seconds** (what the viewer sees
and hears first), its beats (3 to 6, each with what changes), the look (palette, type, motion
style) and the ending.

## The first 2 seconds

The viewer decides in 2 seconds. The hook frame is never black, never a logo alone, never a
loading state, and never a title card that says nothing. It shows the subject or the surprise,
with the claim or question already visible.

# Plan

The plan is a list of shots (1 to 20) the owner approves before anything is built. For each shot:

- `durationSec` between 1 and 15; the shots add up to the target length within 10%.
- `title`: at most 6 words per line, at most 120 characters in total per text value.
- what is on screen, what moves and why, and what the viewer should take from it.
- `fonts` only from the bundled or uploaded list.
- the numbers shown, written exactly as the brief gives them. Do not invent, round or convert
  numbers. If you need a number the brief does not give, list it in `assumptions` instead of
  putting it on screen as fact.

## Beats and pace

Give the film a shape, as shares of the total length: hook about 10%, set-up 20 to 30%, the main
beats 40 to 50%, payoff and ending 15 to 20%. A shot should earn its time: if you cannot say what
the viewer learns or feels in it, cut it or merge it. End on the point, not on a fade to nothing.

## Text on screen

Short, concrete, in the brief's language. One idea per line. Nothing the plan does not need.
Respect the reading time: about 0.25 s per word plus 0.5 s.

# Revising

When asked to change a plan, change only the shots the request names. Keep every other shot's
text, timing and look exactly as it was, and return a one-line summary of what changed.

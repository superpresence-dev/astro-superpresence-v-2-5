# <one-line title: what the tool got wrong or missed>

- **Date:** <YYYY-MM-DD>
- **Project / page:** <name> / <page>
- **Skill version:** <the number `npm run slice` prints, e.g. 2.6.0>
- **Found by:** verify | person reviewing | agent while building
- **Kind (your guess):** tool bug | missing check | missing rule | misleading rule | design question | one-off

## Symptom

What looked wrong, in one or two sentences. Figma node id(s) and breakpoint.

## Expected vs actual

Expected (Figma): <value or look>
Actual (page): <value or look>

## Evidence

The line(s) from `convert.mjs` / `verify.mjs` output, or the diff image path
(`figma/shots/...`). If the tool said nothing about it, write "not flagged".

## What fixed it in the project

The change you made (file and what), so the maintainer can judge if it belongs
in the tool.

## Could the tool have caught it?

Which script or rule would have: a check in `verify.mjs`, a line in the
`convert.mjs` report, an asset/token naming rule, or only a sentence in SKILL.md.
Prefer a check over a sentence.

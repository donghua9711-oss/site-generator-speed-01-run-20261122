# Build a static site faster — entry

![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/donghua9711-oss/site-generator-speed-01-run-20261122/rank.svg)
![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/donghua9711-oss/site-generator-speed-01-run-20261122/reward.svg)

A fast drop-in replacement for makefun-site 1.0.0, for the make.fun
bounty [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` exports `run(input)`, which returns exactly the output
tree makefun-site's build returns for the same input — every page,
the index and tag pages, `build-report.txt` and each static file,
byte for byte. `main.ts` is the harness driver: it reads every
case from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference pipeline is reimplemented with leaner machinery,
stage for stage, with identical semantics:

- the text helpers scan by hand and skip the Unicode
  normalisation for plain-ASCII strings (the common case);
- the front-matter reader walks line offsets instead of
  splitting the whole source, so a body is never copied to be
  read;
- the Markdown reader classifies each line by its first
  characters instead of a battery of regular expressions, and
  its inline pass works on offsets into the original string
  instead of slicing a fresh substring at every mark, jumping
  straight from one mark to the next;
- slugs are memoised per build, because a site repeats its tag
  names and headings across hundreds of sources;
- templates are compiled once into node trees whose paths are
  pre-split, their includes spliced in place under the same
  depth rule the renderer uses, and rendering walks them with a
  plain scope chain, one reused scope per loop and one shared
  root scope per build; a source's card is built once and
  shared by every list that shows it.

Verified locally against the kit's practice set (3 of 3 cases
byte-identical) and against fresh sites drawn by the kit's own
generator. No dependencies; the answer is a function of the
input alone.

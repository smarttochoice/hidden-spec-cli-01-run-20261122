# hidden-spec-cli-01-run-20261122

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/smarttochoice/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/smarttochoice/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend`: one patch tool for every AI edit format. It applies a patch written as a
unified diff (with wrong line numbers tolerated), SEARCH/REPLACE blocks, a V4A
patch, or JSON text-editor tool calls to a tree of text files — every file
changed or nothing, printing what changed or why each edit failed.

Bounty: [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Want to try make.fun yourself? Start here: https://make.fun/r/w57pvztf

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file relative to the working directory (the root of the
tree); absent or `-` reads the patch from standard input. `--format` is
`unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected
from the patch text). `--check` reports what would change without writing
anything. `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 applied (one line per changed path, then `ok: <n> files`), 1
some edits failed (`error: <code> <path>` per failed edit, then
`failed: <k> of <n> edits`, nothing written), 2 usage / unreadable patch /
undetected format / unparseable patch (one `error: ...` line).

## How it works

- Line matching runs at the first of three tiers at which the old lines occur:
  exact, trailing whitespace ignored, leading and trailing whitespace ignored.
  At tier 2 the new lines are re-indented to the file's own indentation and
  context lines are written as the file's own matched lines.
- Unified hunks take the occurrence nearest their (drift-corrected) line
  number, insert pure-addition hunks after `A + d` lines, and honour
  `\ No newline at end of file` for files they touch at the end; sections
  cover creates, deletes and moves (`R old -> new`).
- SEARCH/REPLACE blocks take their path from the nearest preceding line,
  inherit the previous block's path, and fail `ambiguous` unless the old lines
  occur exactly once at their tier.
- V4A sections add, delete, update and move files; chunks anchor on `@@`
  lines, follow a cursor, and `*** End of File` pins a chunk to the end.
- JSON edits are `create` (byte for byte), `str_replace` (exact, once, CRLF
  aware) and `insert` (by line number), as one array or as JSON Lines.
- Paths are checked for safety before anything else; edits apply in order to
  the tree as earlier edits left it, and a failed edit changes nothing while
  the edits after it still run.

No dependencies, Node 22 standard library only. `SPEC.md` is the whole
contract.

## Layout

- `main.ts` — the entry: the CLI
- `runner.ts` — the kit's trial runner (verbatim from the competition kit)
- `check.ts` — the practice-set checker (verbatim from the kit)
- `SPEC.md` — the specification

## Verification

- Practice set: 100/100 checks passed, practice score 1000
  (`node check.ts <kit>/program/generator/practice.json`).
- Hand-built edge cases: 79/79, each computed from a sentence of `SPEC.md`
  (usage errors, unsafe paths, renames, moves and move chains, no-newline
  handling, tier 1/2 matching and re-indentation, `--strict`, nearest-tie
  choice, multi-hunk drift, CRLF preservation, atomicity, `--check` purity,
  path inheritance, V4A anchors/cursor/EOF, JSON faults).
- Invariant fuzz: 700 iterations (600 + 100 sweeps) of random files × random
  patches across all four formats, zero CLI defects: exit codes only 0/1/2,
  exit 1 never writes, `--check` never writes and reports the same stdout,
  repeated runs identical. (The sweeps' only flags were a harness regex that
  rejected multi-row stdout; the flagged outputs were re-checked directly
  and are correct.)

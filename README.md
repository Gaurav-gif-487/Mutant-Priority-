# mutant-priority

**Most mutation-testing tools tell you a kill rate. This one tells you where to point your mutation budget *before* you spend it — and then measures, on your own repo with your own tests, whether that recommendation actually holds.**

Evidence-grounded mutant/test prioritization for JS/TS repos, plus a
built-in way to check whether the evidence holds on *your* repo before
you trust it.

```bash
npx mutant-priority validate ./my-repo
```

No `--entry`, no `--test-cmd` — both are auto-detected from
`package.json` (falls back to a clear error telling you what to pass
if it can't find them, never a silent wrong guess). One command gets
you a real, disclosed, statistically-honest mutation sample and — if
you ask for it — a shareable HTML report:

```bash
npx mutant-priority validate ./my-repo --report report.html
```

This exists because of a specific finding, not a hunch. A prior study
mutated real source files across four real, cloned GitHub repos (a
transpiler, a JSON Schema validator, a reactive-state library, a SQL
query builder) and ran each repo's own real test suite against every
mutant — no simulation. The working hypothesis was **depth-gating**:
that files further from a package's entry point in the import graph
are less tested. That hypothesis **did not hold** — `distFromEntry` was
not a significant predictor of mutant survival in any of the four
repos (p ≥ 0.19 in all four). The only structural signal that *did*
reach significance was **fan-out**, in exactly one of the three repos
where it was tested (ajv, p = 0.006) — higher fan-out correlated with
higher kill rate, i.e. low fan-out files were more likely to hide
undetected mutants.

That's a narrow, honestly-reported result: one replication out of
three, not a law of nature. This tool is built to match that honesty
level. It does three things:

1. **`rank`** — ranks source files by fan-out (low fan-out first, since
   that's the direction the one significant result pointed), with
   `distFromEntry` and `random` available as explicit comparison
   baselines, not because they're recommended.
2. **`validate`** — actually runs a small real mutation-testing sample
   under each strategy's top-ranked files, against your real test
   command, and reports which strategy's top picks have the lowest
   kill rate on *your* codebase. It does not assume the study's finding
   transfers to your repo — it measures whether it does.
3. **`report`** — turns a `validate` run into a shareable HTML report
   and a PR-comment-sized Markdown summary, so the result is something
   a teammate can open in a browser, not just a wall of terminal text.

## Why this exists instead of a bigger tool

The mutation-testing-for-agent-generated-code space already has
credible entrants (multi-language mutant generators, Stryker's
agent-loop mode, various LLM-mutant tools). Building another generic
mutation runner would mostly duplicate what already exists. What none
of those tools ship is a prioritization signal backed by a disclosed,
replicated-only-once, honestly-reported empirical result — and a way
to test that signal against your own repo instead of taking it on
faith. This tool is intentionally narrow: it doesn't run mutation
testing at scale, it tells you *where* to point a mutation budget you
already have (Stryker, mutmut, cargo-mutants, PIT, whatever), and it
lets you verify that recommendation with a real, small, disclosed run
before trusting it for CI gates.

## Install

```bash
npm install -g mutant-priority
# or, from this repo:
npm install && npm run build && npm link
```

## `rank` — prioritize files

```bash
mutant-priority rank ./my-repo --top 20
```

`--entry` is optional — auto-detected from `package.json`'s `main`,
`module`, or `exports` field (falling back to conventional paths like
`src/index.ts`) if omitted; pass it explicitly if your repo's layout
doesn't match any of those.

Options:
- `--entry <path>` — override auto-detection
- `--strategy fanOut|fanIn|distFromEntry|random` (default `fanOut`)
- `--top <n>` — print only the top N
- `--json <path>` — write the full ranked list as JSON
- `--stryker-glob <path>` — write a priority-ordered JSON array of file
  paths. Slice the front N of that array into Stryker's `mutate` config
  (or pass a subset via `stryker run --mutate`) to spend a limited
  mutation budget on the files most likely to be under-tested, instead
  of mutating everything or going in alphabetical/directory order.
- `--scope <dir>` — restrict the graph to files under this directory
  (e.g. `lib` or `src`), relative to root. Useful when source lives
  alongside docs/build/tooling files at the repo root.
- `--staged` — only print files currently staged for commit
  (`git diff --cached`). Metrics are still computed from the whole
  repo graph; this just filters which rows are shown — a quick
  "what am I about to commit, and how does it rank" view. See
  `precommit` below to actually run mutants against staged files.

## `validate` — measure it on your repo before trusting it

```bash
mutant-priority validate ./my-repo \
  --strategies fanOut,distFromEntry,random \
  --files-per-strategy 8 \
  --mutants-per-file 2
```

`--entry` and `--test-cmd` are both optional — `--entry` auto-detects
the same way `rank` does, and `--test-cmd` auto-detects from
`package.json`'s `scripts.test` (run via `npm test` so pre/post-test
hooks still fire). Pass either explicitly if auto-detection can't find
something usable; it fails loudly with a specific reason rather than
guessing wrong silently.

This confirms your test suite passes clean, then for each strategy
takes its top N ranked files, generates a couple of real mutants per
file (boolean-literal inversion; equality/inequality swap, loose and
strict; logical-connector flip; arithmetic-operator replacement;
relational-boundary replacement; increment/decrement swap — a wider
set than the source study's original three kinds, still narrow and
fully enumerated, found via the real AST rather than line regex — see
"How mutants are found" below), applies each one, runs your real test command,
records Killed/Survived, and reverts. It prints a kill rate **and a
95% Wilson confidence interval** per strategy, and a plain-language
verdict that explicitly says whether the difference between the best
and worst strategy is even statistically distinguishable at this
sample size — if the intervals overlap, it tells you not to read the
raw percentages as a ranking, rather than pretending a 5-mutant sample
proves anything. That's the same discipline the source study applied
to itself.

**This runs your real test suite repeatedly and edits real files on
disk (reverting after each run).** Use a clean working tree. It is not
parallelized and is meant for a small, deliberate sample, not full
mutation coverage.

Add `--impact --test-file-cmd "npx mocha {files}"` (any template
containing `{files}`) to run only the test files that transitively
import each mutated file instead of the whole suite — much faster on a
real repo, with an automatic fallback to the full suite per-mutant
when no test file can be statically linked (reported in the output so
you know how often that happened). Add `--scope <dir>` to keep the
graph focused on one subtree, same as `rank`.

`--impact`'s output also reports how many files in the repo contain a
**dynamically-constructed** `require(...)` or `import(...)` — i.e. one
whose argument isn't a plain string literal (`require(pathVar)`,
`import(\`./locales/${lang}.js\`)`). Those are structurally invisible
to the import graph (there's no literal specifier to resolve), so a
fallback-to-full-suite count that includes files like that isn't
necessarily "genuinely untested" — check this note before reading the
fallback count as a coverage gap.

### Test Impact Analysis: `--narrow-by-identifier`

`--impact` alone gives a **file-level** answer: every test file that
transitively imports the mutated file, which is always correct (never
misses a real dependency) but can be coarse in a file with several
unrelated exports, or a barrel file re-exporting a whole subsystem.
Adding `--narrow-by-identifier` further filters that list down to test
files that textually reference at least one of the mutated file's
exported names — a cheap, best-effort heuristic (regex over source
text, not a real binder), not a replacement for the file-level answer:
it only ever *shrinks* the list, and only when the shrink is
non-empty, so it can't accidentally narrow a real dependency away to
nothing. Diagnosed separately in the output (`mutantsNarrowedByIdentifier`
in `--json`) so you can see how often it actually helped on your repo.

```bash
mutant-priority validate ./my-repo \
  --impact --test-file-cmd "npx mocha {files}" \
  --narrow-by-identifier
```

### Sound Test Impact Analysis, for real: `--coverage`

`--impact`/`--narrow-by-identifier` are both **static**: they reason
about the import graph and source text, never actually run anything to
find out. `--coverage` is the other kind of answer: it builds a REAL
per-test coverage index up front — one instrumented run per test file,
via Node's built-in `NODE_V8_COVERAGE` (block-level coverage, not just
per-function) — then, for each mutant, looks up exactly which tests'
real, executed coverage includes that exact character offset.

```bash
mutant-priority validate ./my-repo \
  --coverage --test-file-cmd "node --test {files}"
```

This is strictly sounder than the static options, in both directions:

- A mutant whose offset a test genuinely executes gets narrowed to
  precisely the test(s) that do — finer than file-level, and not a
  text-match guess.
- A mutant whose offset **no** test executes is provably going to
  survive, so it's reported `Survived` directly, **without spawning a
  test process at all** — the coverage data already proves the
  outcome. On a file with dead branches or defensive code the current
  suite never reaches, this both saves real time and stops "no test
  covers this" from silently looking identical to "a test covers this
  and still didn't catch the mutation."

The cost is upfront and one-time, not per-mutant: building the index
runs each test file once (not once per mutant), before the mutation
loop starts. On a repo with many test files this is a real cost worth
weighing against `--files-per-strategy`/`--mutants-per-file`, but it
doesn't scale with mutant count the way running the full suite per
mutant would.

`--coverage` composes with `--impact`: any file the coverage index has
no data for at all (never instrumented by any test run) falls back to
`--impact`'s static answer, then the full suite — the same layered,
never-lose-correctness fallback shape `--impact`'s own fallback uses.
`validate`'s output reports how many mutants were narrowed by real
coverage, how many were skipped outright, and how many fell back
(`coverageStats` in `--json`). `precommit --coverage` is the same
feature, scoped to staged files.

### Flakiness: `--flaky-retries`

A test suite with any shared state, timing sensitivity, or network
dependency can fail for reasons that have nothing to do with the
mutation just applied — which this tool, like any mutation tester,
would otherwise happily record as "Killed." `--flaky-retries <n>`
re-runs a mutant up to `n` extra times **only when its first result is
"Killed"** (a first result of "Survived" isn't retried — a flaky test
that happens to pass anyway doesn't inflate the kill rate, so there's
nothing to protect against there). If the retries don't all agree with
the first attempt, the mutant is reported as **"Flaky"** instead of
Killed or Survived, and excluded from the kill-rate calculation
entirely (folding it into either bucket would bias the rate in
whichever direction it happened to land on this run).

```bash
mutant-priority validate ./my-repo --flaky-retries 2
```

Combine with `--workers` for extra protection against a common cause
of flakiness under concurrency: each worker slot gets its own
`TMPDIR`/`TEMP`/`TMP` (a subdirectory of that slot's isolated repo
copy) and a `MUTANT_PRIORITY_WORKER_ID` env var, so two concurrent test
runs writing "the same" temp file, or picking a port from a
worker-id-like env var, don't collide.

### Performance: `--tsc-watch` and `--workers`

Two flags for when a real sample means dozens-to-hundreds of mutants,
each needing a real build + test run:

- **`--tsc-watch`** — on a TypeScript repo, the test command's build
  step (`tsc`, typically via `npm run build`) is usually the single
  biggest cost per mutant: a clean `rm -rf dist && tsc` rebuild for a
  one-character change. `--tsc-watch [--tsconfig <path>]` keeps one
  persistent `tsc --watch` process running for the whole `validate`
  run instead, and waits for it to settle incrementally after each
  mutant. **`--test-cmd` in this mode must be the test-runner
  invocation only** (e.g. `"mocha dist/**/*.test.js"`), not
  `"npm run build && mocha ..."` — the watcher is what keeps `dist/`
  current now.
- **`--workers <n>`** — runs N mutants concurrently, each against its
  own isolated snapshot of the repo (a temp-directory copy with
  `node_modules` symlinked back in — not `git worktree`, so it works
  identically in a non-git repo and captures uncommitted/untracked
  changes exactly, which `git worktree add` would silently drop).
  Composes with `--tsc-watch` (each worker gets its own watcher).
  Default `1` (sequential, unchanged from before this flag existed).

```bash
mutant-priority validate . \
  --test-cmd "mocha dist/test/*.test.js" \
  --tsc-watch --workers 4 \
  --files-per-strategy 20 --mutants-per-file 3
```

Measured on a small real TS fixture with a deliberately slow test
command: 9 sequential mutant runs took 12s; the same run with
`--workers 4` took 6s, with identical kill-rate results — this is real
concurrency (via async child processes, not `execSync`, which blocks
the whole Node process and makes true parallelism impossible from a
single one), not just more log lines interleaved.

### Report: a shareable artifact, not just a terminal dump

```bash
mutant-priority validate ./my-repo --report report.html --markdown summary.md
```

- `--report <path.html>` writes a **self-contained** HTML report (all
  CSS inline, zero external requests, opens directly in a browser with
  no build step) — one card per strategy with its kill rate and 95%
  confidence interval, plus a collapsible per-mutant table (file, line,
  mutation kind, Killed/Survived) underneath each strategy.
- `--markdown <path.md>` writes a compact summary sized for a PR
  comment or a GitHub Actions job summary — a results table plus the
  plain-language verdict, with a link to the HTML report if you also
  passed `--report`.

Already have a saved `validate --json` report and just want the other
artifact shapes without re-running anything? Use the standalone
`report` command:

```bash
mutant-priority report saved-report.json --html report.html --markdown summary.md
# or, with neither flag, prints the Markdown summary straight to stdout:
mutant-priority report saved-report.json
```

A real example, generated from this repo's own `fixtures/sample-repo`,
is checked in at [`examples/sample-report.html`](examples/sample-report.html) — open it directly to see
what the output looks like before running anything yourself.

## CI: run it on every PR

[`examples/github-action.yml`](examples/github-action.yml) is a
copy-paste GitHub Actions workflow: on every PR touching JS/TS files,
it runs `validate`, posts a Markdown summary as a PR comment (updating
the same comment on subsequent pushes rather than piling up new ones),
adds the summary to the job's summary tab, and uploads the full HTML
report as a downloadable build artifact. Copy it to
`.github/workflows/mutant-priority.yml` in your repo and adjust
`--files-per-strategy`/`--mutants-per-file` for your CI time budget.

### Crash-resumable runs: `--checkpoint`, `--shard`, `aggregate`

A sample large enough to say anything statistically (dozens to
hundreds of mutants, each needing a real build + test run) can take
hours. `--checkpoint <path>` makes that survivable:

```
mutant-priority validate . --entry src/index.ts --test-cmd "npm test" \
  --strategies fanOut,distFromEntry --files-per-strategy 40 --mutants-per-file 2 \
  --checkpoint run.jsonl
```

Every mutant's outcome is appended to `run.jsonl` (one JSON object per
line) the moment it's known. If the process is killed — `kill -9`, an
OOM kill, a sandbox/container reset — just run the exact same command
again: a non-empty checkpoint skips the baseline reconfirmation (a
prior run in this tree already passed it) and skips every mutant
already recorded, picking up only what's left.

This also fixes a real failure mode, not just a hypothetical one: a
mutant is applied by writing the mutated file to disk, then reverted
in a `finally` block after the test command runs — but `SIGKILL` can't
be caught, so a process killed mid-mutant leaves that one file mutated
on disk. Left alone, a resumed run would read that corrupted content
back as if it were pristine source and compute wrong mutants against
it for the rest of that file. `--checkpoint` guards against this: the
first time a file is about to be touched, its pristine content is
written to the checkpoint too; every subsequent run restores that
content unconditionally before reading the file again — a no-op if
nothing was actually corrupted, a real fix if it was. This was found
and confirmed by deliberately `kill -9`-ing a checkpointed run
mid-mutant and checking the file was byte-identical to pristine after
resuming, not assumed to work from reading the code.

`--shard i/n` splits one strategy's ranked file list across N parallel
copies of the same command (each with its own `--checkpoint` file) —
shard `i` takes ranked-list positions where `pos % n === i`, so running
all N shards covers every file exactly once with no coordination
between them:

```
# in 4 separate terminals/processes:
mutant-priority validate . --entry src/index.ts --test-cmd "npm test" \
  --strategies fanOut --files-per-strategy 40 --mutants-per-file 2 \
  --checkpoint shard0.jsonl --shard 0/4
# ...--checkpoint shard1.jsonl --shard 1/4, etc.
```

Then combine them — or just re-print a finished run's summary from
its checkpoint alone — with `aggregate`, which recomputes kill rates,
Wilson intervals, and the verdict purely from the checkpoint file(s),
no live run or test command needed:

```
mutant-priority aggregate shard0.jsonl shard1.jsonl shard2.jsonl shard3.jsonl
```

## `stryker` — feed the ranking into a real Stryker run

```bash
mutant-priority stryker ./my-repo \
  --entry src/index.ts \
  --strategy fanOut \
  --budget 30 \
  --config stryker.conf.json
```

**This is not a Stryker plugin.** Stryker's plugin API (TestRunner /
Reporter / Checker interfaces, its DI container, its own peer-dependency
contract) is a much larger surface than reordering a file list needs,
and building one just for this would add real maintenance weight for a
single feature. What this command does instead is narrower and just as
useful in practice: it writes (or patches, preserving every other field)
a real `stryker.conf.json`'s `mutate` array so the files this tool
considers most likely under-tested come first. Pass `--budget N` to
slice to only the top N files — that gives you a working,
budget-constrained Stryker run today (`stryker run` afterward, as
normal) without waiting on a plugin. If Stryker's own plugin system
grows a first-class prioritization hook later, this could move there;
until then, editing its config is the honest way to plug in from
outside.

## `precommit` — a fast, per-commit tripwire on staged files

```bash
mutant-priority precommit .
```

Where `validate` runs a deliberate, statistically-compared sample
across the whole repo and `rank`/`stryker` prioritize a Stryker run,
`precommit` answers a narrower, faster question: **is the change I'm
about to commit right now obviously under-tested?** It reads the files
currently staged for commit (`git diff --cached --name-only
--diff-filter=ACMR` — a staged deletion is correctly excluded, there's
nothing left to mutate), confirms the test suite passes clean, samples
a couple of real mutants per staged source file (test files themselves
are skipped — nothing to check), runs them, and exits non-zero if any
mutant survives.

```bash
mutant-priority precommit . \
  --mutants-per-file 2 \
  --impact --test-file-cmd "npx mocha {files}" \
  --narrow-by-identifier
```

`--test-cmd`/`--entry` auto-detect the same way `validate` does.
`--impact`/`--test-file-cmd`/`--narrow-by-identifier`/`--coverage` work
exactly as they do in `validate`, scoped to each staged file — worth
adding once you know they work on your repo, since a pre-commit hook's
whole value depends on staying fast enough that nobody reaches for
`--no-verify`. `--coverage` in particular has an upfront cost (one
instrumented run per test file to build the index) that's worth
weighing against how many mutants you're sampling per commit; on a
repo with a small, fast test suite it's a clear win (real, per-mutant
narrowing plus dead-code mutants skip the test run entirely), on one
with a slow suite `--impact` alone may be the better tradeoff for a
hook that has to run on every commit.

**Wire it into a git hook** with [husky](https://typicode.github.io/husky/)
(or any other pre-commit runner — the tool itself doesn't care how
it's invoked): copy `examples/pre-commit` into `.husky/pre-commit`
after `npx husky init`, or lift the one `npx mutant-priority precommit
.` line into your existing hook. An empty staged set, or a staged set
that's entirely test/non-JS-TS files, passes vacuously rather than
blocking — a hook that runs unconditionally on every commit shouldn't
block a commit that touches nothing mutation-testable (a docs-only
change, a config tweak).

This is deliberately narrow: 1-2 mutants per file, no strategy
comparison, no confidence interval. A pass here means "no obvious gap
in what you just staged," not "this code is well-tested" — reach for
`validate` when you actually want that stronger claim.


## Real-world check: ajv

I ran `validate` against the actual [ajv](https://github.com/ajv-validator/ajv)
repo (the same one the source study used, where fan-out was the one
signal that reached significance) — not a synthetic fixture. Worth
recording exactly what that took and what it found, warts included.

**What running it for real actually required:** cloning the repo,
`npm install`, initializing two git submodules for its
JSON-Schema-Test-Suite fixtures, generating `spec/_json/*.js` from
those fixtures, and `npm link`-ing ajv to itself (its spec suite
imports `ajv` as an installed package, which resolves to `dist/`, not
`lib/` — mutating `lib/*.ts` only has an effect if `dist/` is rebuilt
first, which `--test-cmd`/`--test-file-cmd` has to include). That's
the same kind of per-repo setup work the source study's own scripts
had to do for each of its four repos.

**A baseline problem that had nothing to do with this tool:** ajv's
full spec suite had 58 pre-existing failures on this environment (Node
22), all confined to its JTD (JSON Type Definition) module —
`spec/jtd-schema.spec.ts`, `spec/types/jtd-schema.spec.ts`, and
`spec/options/int32range.spec.ts`. JTD is a separate schema dialect
from the Draft-07 validator this run's entry point (`lib/ajv.ts`)
implements, and those 58 failures are 0.7% of the suite (6296 pass
cleanly). I set those three files aside for the run rather than either
silently absorbing 58 "kills" that have nothing to do with any mutant,
or quietly cherry-picking around them without saying so.

**The run**: `--scope lib --entry lib/ajv.ts --strategies
fanOut,distFromEntry --files-per-strategy 6 --mutants-per-file 1
--impact`, budgeted to fit a single sitting (each mutant needs a real
`tsc` rebuild + mocha run, ~15-40s depending on whether `--impact`
found a narrow test target). Result:

```
fanOut:         3/4 killed (75.0%)  95% CI [30.1%, 95.4%]
distFromEntry:  2/4 killed (50.0%)  95% CI [15.0%, 85.0%]
```

Only 4 mutants per strategy made it in (several ranked files had no
mutable tokens under this tool's narrow mutator set — pure
type/interface files, mostly). The CIs overlap, so — exactly as the
tool is supposed to say when that happens — **this run does not show a
statistically distinguishable difference between the two strategies**.
It also doesn't reproduce the direction of the source study's ajv
result (which found fan-out positively correlated with kill rate at
n≈hundreds of mutants); at n=4 that's not a contradiction, it's just
an underpowered sample, which is the whole reason the tool prints a
confidence interval instead of a bare percentage.

**A real limitation this surfaced**: 3 of the 8 sampled files (all
`lib/runtime/*.ts` helpers) fell back to the full suite under
`--impact`, because ajv's spec files import the built `ajv` package via
its own name (`require("ajv")`), not `lib/*.ts` paths directly — so the
static reverse-import graph this tool builds couldn't connect a test to
what it actually exercises.

*Update*: re-ran the full ajv pipeline end-to-end a second time
(fresh clone, submodules, `npm link`, JTD exclusion) specifically to
confirm the self-import fix on ajv itself, not just on the synthetic
fixture. Baseline: 6296 passing, same as before. Result:

```
fanOut:         2/4 killed (50.0%)  95% CI [15.0%, 85.0%]
distFromEntry:  2/4 killed (50.0%)  95% CI [15.0%, 85.0%]
```

Overlapping CIs again — no distinguishable difference, same as the
first run. 5 of 8 sampled files got a narrowed test set; the same 3 as
before still fell back to the full suite: `parseJson.ts`, `quote.ts`,
`timestamp.ts`.

Worth being precise about what the fix did and didn't do here, since
the numbers look unchanged at first glance. It **is** working: mutants
now connect to `spec/issues/1935_integer_narrowing_subschema.spec.ts`,
the one spec file that does `import Ajv from "ajv"` literally — that
connection didn't exist before the fix. But checking why the same 3
files still fall back turned up something the original framing got
wrong: all three (`parseJson.ts`, `quote.ts`, `timestamp.ts`) are
imported *exclusively* from `lib/compile/jtd/*` and
`lib/vocabularies/jtd/*` — JTD-only code paths — and the only specs
that exercise JTD are the same 3 files excluded from this run's
baseline (Node 22 JTD failures, noted above). There is no non-JTD test
that could statically reach them, static resolution or not, so the
fallback there is correct behavior, not a residual gap.

The self-import fix also doesn't cover most of ajv's suite the way the
original framing implied: only that one spec file imports `ajv` by bare
package name. The other ~30 spec files go through a local `spec/ajv.ts`
wrapper that does `require("" + "..")` — a string-concatenated require,
unresolvable by static analysis by construction (most likely to dodge
bundler inlining in ajv's browser build). That's a different, genuinely
unfixable-by-static-analysis case, not the pattern this fix targets.
A helper wired in purely through code generation with no static import
anywhere would still fall back regardless, for the same reason.

*Update — a real sample size*: every result above was n=4 per
strategy, below this tool's own `MIN_MUTANTS_FOR_COMPARISON` threshold
of 8 — the CLI was flagging its own output as "(small sample)" in both
runs, correctly. Re-ran with `--files-per-strategy 15` (still `--scope
lib --entry lib/ajv.ts --impact`, same baseline exclusions) to actually
cross that threshold:

```
fanOut:         4/8  killed (50.0%)  95% CI [21.5%, 78.5%]  across 15 files
distFromEntry:  7/12 killed (58.3%)  95% CI [32.0%, 80.7%]  across 15 files
```

Neither strategy is flagged as a small sample anymore. The CIs still
overlap — still not statistically distinguishable — and notably the
*direction* flipped from the very first n=4 run (which had fanOut
ahead at 75% vs distFromEntry's 50%). That flip is itself the honest
finding: at n=4, which strategy looks better is close to a coin flip,
and this tool's own confidence-interval reporting is what stops that
noise from being read as a ranking. `--impact` also scaled cleanly at
this size: 16 of 20 mutants ran against a narrowed test set (4 fell
back, the same JTD-only files as before, correctly), and the new
dynamic-require diagnostic reported the 8 files using ajv's
`spec/ajv.ts`-style wrapper in the same run.

This still isn't the hundreds-of-mutants scale the source study used,
and it still doesn't reproduce that study's fan-out-correlates-with-
kill-rate direction on ajv specifically — but it's the first result
from this tool on ajv that clears its own bar for "read the CI, not
just the percentage."

*Update — hundreds of mutants, and a crash-resume system built to get
there*: getting to the source study's actual scale meant a run that
takes hours, not one sitting — each mutant needs a real `tsc` rebuild
plus a mocha run, and a run of this size will get interrupted by an
environment reset well before it finishes. So before attempting it,
`validate` gained a `--checkpoint <path>` option: every mutant's
outcome is appended to a JSON-lines file the instant it's known, and a
non-empty checkpoint on startup skips already-recorded mutants and
skips re-confirming the baseline (a prior run in the same tree already
did). A new `aggregate` command recomputes kill rates, Wilson CIs, and
the verdict from one or more checkpoint files alone — no live repo, no
test command, just the records. `--shard i/n` splits one strategy's
ranked file list deterministically across parallel runs for the same
reason.

Building this surfaced a real correctness bug, found by actually
running `kill -9` mid-mutant rather than reasoning about it in the
abstract: a mutant is applied to disk, the test command runs, and the
mutation is reverted in a `finally` block — but `SIGKILL` can't be
caught, so a process killed mid-test leaves the file mutated on disk.
A naive resume would read that corrupted content back as if it were
pristine source and compute the remaining mutants against
already-broken code. Fixed by recording each file's pristine content
once, the first time a checkpoint run is about to touch it, and
unconditionally restoring that content before the file is read again
on any resume — a no-op if nothing was actually corrupted, correct
either way. Verified with an actual kill: a control run (never killed)
got 5/7 mutants killed; a run killed mid-mutant and resumed from
checkpoint got the same 5/7, with identical per-mutant outcomes and
the source file left clean. `checkpoint.test.ts` and `validate.test.ts`
cover this in the automated suite too — round-trips, corrupt-line
tolerance (a truncated last line is dropped; a corrupt line anywhere
else throws, since guessing which to discard would make resume
unpredictable exactly when it matters), the resume-skips-done case,
and resume-equals-uninterrupted.

The real run then hit exactly what this was built for: the sandbox
reset mid-flight, twice, confirmed via a fresh-boot `dmesg` each time
and a leftover mutated file in ajv's git status
(`lib/vocabularies/validation/const.ts` and, later,
`lib/vocabularies/validation/pattern.ts` and
`lib/runtime/timestamp.ts` — each reverted with `git checkout --`
before resuming, since the checkpoint's own backup-and-restore only
covers files it has already recorded pristine content for). Each time,
relaunching with the same `--checkpoint` path printed exactly what it
should — "already has N recorded outcome(s)... skipping baseline
reconfirmation... resuming" — and picked up mid-file rather than
restarting.

`--scope lib --entry lib/ajv.ts --strategies fanOut,distFromEntry
--files-per-strategy 100 --mutants-per-file 3 --impact`, run to the
point where fanOut's ranked file list was exhausted (mutant count
stopped climbing across repeated checks — most of the remaining ranked
files are pure type/interface code with no mutable tokens) and
distFromEntry's climb had slowed to a crawl (it started hitting more
files that fall back to the full suite under `--impact`, each taking
noticeably longer). Final result, 343 mutants total:

```
fanOut:         81/181 killed (44.8%)  95% CI [37.7%, 52.0%]  across 70 files
distFromEntry:  75/162 killed (46.3%)  95% CI [38.8%, 54.0%]  across 61 files
```

This is the real thing: both strategies well past the sufficiency
threshold, both intervals tight (±7 points, not ±30), and they land
almost on top of each other. Across every sample size run on ajv in
this README — n=4, n=8/12, n=181/162 — the two strategies have never
once been statistically distinguishable, and the point estimates have
converged rather than diverged as the sample grew (75% vs 50% at n=4;
44.8% vs 46.3% at n≈170). That convergence is itself informative: it's
what a genuinely absent effect looks like as noise averages out, not
what an underpowered-but-real effect looks like. On this repo, at this
scale, fan-out prioritization does not measurably outperform (or
underperform) prioritizing by distance-from-entry. That doesn't
contradict the source study, which never claimed fan-out would
replicate everywhere — it replicated in 1 of 3 repos there too — but it
means ajv, the repo used for the very first "does this even work"
check in this README, ends up in the *non-replication* column rather
than the replication column, once the sample size is actually large
enough to say so.


## Library usage

```ts
import { buildGraph, rank, validate } from "mutant-priority";

const graph = buildGraph("./my-repo", "src/index.ts");
const ranked = rank(graph.perFile, "fanOut");

const report = await validate({
  root: "./my-repo",
  entry: "src/index.ts",
  testCommand: "npm test",
  strategies: ["fanOut", "distFromEntry", "random"],
  filesPerStrategy: 8,
  mutantsPerFile: 2,
  timeoutMs: 20000,
});
```

## How mutants are found

Mutants are located by walking the real TypeScript AST (via the
`typescript` compiler API), not by regexing lines of text. This matters:
a naive line-regex mutator will happily "mutate" a `&&` sitting inside a
string literal, a comment, or a regex literal, producing a fake mutant
that was never real code. The AST walk only visits genuine
`BinaryExpression` operator tokens, `true`/`false` keyword nodes, and
`++`/`--` unary expressions, so text that merely *looks* like a mutable
token — inside strings, comments, or regex literals — is never touched.
Applying a mutant splices the exact token span in the original source,
so nothing else in the file changes.

The full enumerated set:

| Kind | Example |
|---|---|
| `BooleanLiteralInversion` | `true` ↔ `false` (skipped when it's a TS literal *type*, e.g. `let a: true`) |
| `EqualityReplacement` | `==` → `!=` |
| `InequalityReplacement` | `!=` → `==` |
| `StrictEqualityReplacement` | `===` → `!==` |
| `StrictInequalityReplacement` | `!==` → `===` |
| `LogicalConnectorFlip` | `&&` ↔ `\|\|` |
| `ArithmeticOperatorReplacement` | `+`↔`-`, `*`↔`/`, `%`→`*` |
| `RelationalBoundaryReplacement` | `<`↔`<=`, `>`↔`>=` |
| `IncrementDecrementReplacement` | `++`↔`--` (prefix and postfix) |

Deliberately excluded, at least for now: bitwise operators (`&`, `\|`,
`^`), exponentiation (`**`), compound assignment (`+=` etc.), unary
sign flip (`-x`), and any literal-value perturbation (e.g. incrementing
a numeric literal). `ArithmeticOperatorReplacement` has one disclosed
imprecision worth knowing about: `+` is ambiguous between numeric
addition and string concatenation, and this tool has no type checker,
so a string-concat `+` gets mutated into `-` just like a numeric one —
usually producing a mutant that's trivially killed (`NaN` vs a string)
rather than a meaningful one. Not fixed; disclosed instead.

## Path resolution

The import graph resolves relative imports (`./foo`, `../bar`) directly,
`tsconfig.json`/`jsconfig.json` path aliases (`compilerOptions.baseUrl`
+ `paths`, including wildcard patterns like `"@/*": ["src/*"]` and
exact-match aliases) via the TypeScript compiler's own config parser
so `extends` chains resolve the way `tsc` would, and monorepo
workspace packages (`package.json` `workspaces` globs — array or
`{ packages: [...] }` form — or `pnpm-workspace.yaml`'s `packages:`
list, resolved through each package's `exports` map or `main`/`module`
field, including wildcard subpath exports). `--impact` mode also
resolves one more case on top of all that: a test file importing the
package under its own name (`require("my-package")` from inside
`my-package`'s own repo — the pattern ajv's spec suite actually uses)
resolves to the declared entry file, the same way a workspace
package's bare name resolves to its main entry. Anything left
unresolved after all of that is treated as an external package and
excluded from the graph, not silently miscounted. `--scope` can be
used to keep the graph focused on one subtree of a larger repo — see
Limitations.

## Tests

`npm test` builds and runs the test suite (`node`'s built-in test
runner — no extra test-framework dependency). 134 tests across every
module, including the flaky-retry state machine (a first "Killed"
attempt that stays Killed across retries vs. one that flips to
"Survived" and is correctly reported as "Flaky," and proof a first
"Survived" is never retried at all), the exported-name extraction and
`--narrow-by-identifier` narrowing (including its fallback to the
full list on an unnamed default export), the dynamic-`import()`
diagnostic (mirroring the dynamic-`require()` one below),
`precommit`/`getStagedFiles` end-to-end against a real git repo
(a real `git init`+`add`+`commit`, including proof that a staged
deletion is excluded via `--diff-filter`), and `--coverage`'s real
per-test coverage index end-to-end against actually-running Node
processes — including proof it correctly tells apart an executed
branch (narrowed to the real covering test, then actually run and
Killed) from a genuinely dead one (reported Survived with zero test
processes launched for it), a file the index never instrumented
(returns "unknown," not "uncovered"), and that a test file which
throws mid-run still contributes whatever it covered before failing.
Graph construction and all
four import-resolution paths
(relative, tsconfig aliases, npm/yarn workspaces, pnpm workspaces),
the `--impact` self-import fix *and* proof that it's actually doing
the work (same assertion fails when `entry` is omitted), the dynamic-require
diagnostic against ajv's exact `require("" + "..")` pattern, every
mutator kind (including that TS literal types like `let a: true` are
correctly skipped, and that string/comment/template content is never
touched), `stryker.conf.json` create-vs-patch behavior, Wilson-interval
edge cases, `rank`'s ordering per strategy including the seeded
random strategy's determinism, the `--checkpoint`/`--shard`/
`aggregate` crash-resume machinery — including a test that a file left
mutated by a simulated crash gets restored to byte-identical pristine
content before the next run touches it again, and that N shards over
the same repo cover every file exactly once with no overlap — entry
and test-command auto-detection (including the not-yet-built
`dist/main` → `src/` fallback, and the conditional-`exports` object
case), the `--tsc-watch` incremental-build driver against a real
spawned `tsc --watch` process (not mocked), the `--workers` pool
(real filesystem snapshotting, `node_modules` symlinking, and that
concurrency is actually bounded to the slot count, not just labeled as
such), and the HTML/Markdown report renderers (HTML-escaping, a
failed-baseline report rendering without throwing). `runOneMutant`/`confirmBaseline` are
covered by integration tests that spawn a real shell command against a
temp file, including a regression test for the `/bin/bash`-vs-`/bin/sh`
brace-expansion bug mentioned above. Everything in this list is
something a future change could plausibly break silently; none of it
was previously covered by anything beyond the manual fixture runs
described elsewhere in this README.

## Limitations (stated plainly, matching the source study)

- **Mutator set is wider than the source study's but still narrow**:
  boolean-literal inversion; equality/inequality swap (loose and
  strict); logical-connector flip; arithmetic-operator replacement;
  relational-boundary replacement; increment/decrement swap. Still no
  bitwise, exponentiation, compound-assignment, unary-sign, or
  literal-value mutators — see "How mutants are found" for the full
  list and the disclosed `+`/string-concatenation imprecision. A
  file's true survival rate under a fuller mutator set could differ.
  Use `validate` as a directional signal, not a certified score.
- **Static import graph, not runtime call graph**: fan-in/fan-out/depth
  come from parsing `import`/`require`/dynamic-`import` statements
  (plus tsconfig path aliases, workspace packages, and — in `--impact`
  mode — self-package-name imports), not from tracing what actually
  executes during tests. Barrel-file re-exports can still distort this.
- **`--impact` still can't see through a genuinely dynamic or
  code-generation-only relationship** — e.g. a helper only ever
  referenced by string inside generated code, or reached only through
  a `require()`/`import()` call whose argument isn't a plain string
  literal (e.g. `require("" + "..")`, `require(pathVar)`, `` require(`${x}`) ``,
  or the ES-module equivalents like `` import(`./locales/${lang}.js`) ``
  for route-based code-splitting or i18n loading — ajv's own
  `spec/ajv.ts` wrapper does exactly the `require` version, on purpose,
  likely to dodge bundler inlining). Self-package-name imports
  (`require("my-package")` from inside its own repo) are resolved; a
  dynamically-constructed require/import or a helper wired in purely
  through codegen has no static edge to find regardless, and correctly
  falls back to the full suite rather than guessing. `validate --impact`
  counts and reports how many files in the repo contain such a dynamic
  `require()` **or** `import()`, so a fallback can be told apart from
  genuinely untested code instead of looking identical to it.
  `--narrow-by-identifier` goes one step further than the plain
  file-level `--impact` list — narrowing to test files that actually
  reference the mutated file's exported names — but it's a text-match
  heuristic on top of the (always-correct) file-level graph, not a real
  call graph: it can only shrink the list, never grow it past what
  `--impact` alone already found. `--coverage` is the actually-sound
  version of the same idea — see its own section above — built from
  real execution instead of static text/import analysis; reach for it
  when `--narrow-by-identifier`'s heuristic isn't precise enough and
  the one-time per-test-file instrumentation cost is affordable.
- **Test commands run under `/bin/bash` explicitly**, not Node's
  default `/bin/sh` — on most Linux systems `/bin/sh` is dash, which
  silently fails to expand brace patterns (`{ts,js}`) and globstar
  (`**`), both common in real npm test scripts. This was a real bug
  caught while preparing the ajv run above, not a theoretical one.
- **`--scope <dir>`** restricts the graph to one subtree (e.g. `lib`)
  while still using the full repo root as the working directory for
  test commands — needed on repos where source and build/docs/tooling
  files live side by side at the root (again, ajv). Without it, the
  ranking includes noise from directories the entry point never
  reaches.
- **The pnpm-workspace.yaml reader is a minimal, purpose-built parser**,
  not a general YAML parser — it only understands a top-level
  `packages:` key followed by a `- 'glob'` list. YAML anchors, nested
  workspace catalogs, or anything more exotic in that file won't parse.
- **`validate` does not coordinate with anything else touching the same
  working tree.** Running two `validate` invocations against the same
  repo at once — even with different checkpoint files — is not safe:
  they'll each rebuild/mutate the same files out from under each other.
  This isn't hypothetical; it happened while preparing the ajv run
  above; one instance's baseline check failed because another was
  mid-rebuild. Use `--shard` for deliberate parallelism (each shard
  only touches files at its own reverse-index positions), not two
  unsharded runs against the same tree.
- **The crash-resume backup only covers files a checkpoint run has
  already recorded pristine content for.** If the process is killed
  before that per-file "original" record is written (or if a repo
  isn't checkpointed at all), a `SIGKILL` mid-mutant can still leave a
  file mutated on disk with nothing to auto-restore from — `git status`
  and `git checkout --` any such file before resuming or re-running, if
  the repo is git-tracked. This happened for real, more than once,
  while producing the large-sample ajv result above, and was resolved
  exactly that way each time.
- **The fan-out signal replicated in 1 of 3 repos tested for it** in the
  source study, and `distFromEntry` replicated in 0 of 4. ajv — the
  repo this README uses for its own real-world check — is now a fourth
  data point for fan-out specifically, at a real sample size (343
  mutants total): no distinguishable difference at all, joining
  `distFromEntry`'s non-replication column rather than fan-out's
  replication column. Treat the default ranking as a reasonable
  starting guess worth checking with `validate` on your own repo, not
  a settled fact about your codebase — ajv is a second repo, after the
  source study's own three, where fan-out specifically did not pan out.
- **`validate`'s sample sizes are small by design** (a handful of files,
  1–2 mutants each) to keep runtime bounded, and it reports a 95% Wilson
  confidence interval alongside each kill rate so overlapping intervals
  aren't mistaken for a real ranking. Below 8 mutants for a strategy,
  the CLI flags it as a small sample explicitly. Larger samples give
  more trustworthy estimates at proportional time cost.
- **`stryker` edits a config file, it isn't a Stryker plugin** — see the
  section above. It only ever writes the `mutate` key (and `$schema` if
  absent); every other field in an existing config is preserved as-is,
  but it does not validate the rest of the config is well-formed.
- **`--workers` copies the whole repo per slot** (`node_modules`
  symlinked, not copied, but everything else is a real filesystem
  copy). Fine for small-to-medium repos; on a very large repo the copy
  time itself could start to dominate, at which point `git worktree`
  with the local diff reapplied on top would be the better approach —
  not implemented here (see `worker-pool.ts` for the tradeoff written
  out in full).
- **`--tsc-watch` detects a settled recompile by matching `tsc`'s own
  English watch-mode status text** (`"Starting incremental
  compilation"` / `"Watching for file changes."`), not a file-system or
  IPC signal — `tsc --watch` has no other completion hook to attach to.
  This assumes the default English locale and a debounce window wide
  enough that a mutant's file write lands before the next status line;
  both hold in practice, neither is enforced.
- **Auto-detected `--entry`/`--test-cmd` only look at `package.json`**
  (`main`/`module`/`exports` for entry, `scripts.test` for the test
  command) plus a short list of conventional file paths for entry. A
  repo with a real entry point or test command that doesn't show up in
  any of those places needs `--entry`/`--test-cmd` passed explicitly —
  auto-detection is designed to fail with a specific error rather than
  guess wrong silently, not to cover every possible repo layout.
- **No IDE extension, and no persistent in-process test runner.**
  `precommit`/`validate` are CLI-only — there's no VS Code extension
  surfacing results inline in the editor, and every test run is a real
  spawned child process (`node_modules`'s own test runner, whatever
  it is), not a warm, persistent worker holding a runner's in-process
  API open across mutants. The latter is deliberate, not an oversight:
  `--test-cmd`/`--test-file-cmd` are arbitrary shell strings so this
  tool works with Mocha, Jest, Vitest, `node --test`, or anything else
  without depending on any one runner's API — a true persistent
  in-process runner would have to be built per-runner and would give
  up that generality. `--tsc-watch` and `--workers` (persistent
  incremental builds, warm isolated worker copies reused across the
  whole run) are this tool's answer to the same "avoid paying
  process/rebuild overhead per mutant" problem within that constraint.

## License

MIT

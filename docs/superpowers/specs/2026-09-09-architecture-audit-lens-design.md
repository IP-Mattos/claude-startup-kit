# Architecture audit lens

Date: 2026-09-09
Status: approved

## Context

CSK's existing audit (`run_audit`, `src-tauri/src/lib.rs`) runs eleven checks
against `~/.claude` and OS-level state: processes, hooks, permissions,
scripts, plugins, logs, disk, network, drift, env, startup. It never reads
the source code of the user's projects.

The Gentleman Programming Book supplies a set of architecture rules that are
mechanically checkable and that nothing in this toolchain checks today. Nine
of its chapters converge on the same idea from different angles — Hexagonal
(3), Algorithms (6), Clean Architecture (7, 8), React (9), TypeScript (10),
Barrels (13), the Frontend Manual (16) and Software Architecture (18). This
change adds the first slice of that rule set to CSK.

The headline rule of the book, the Scope Rule ("code used by one feature
stays local, code used by two or more moves to `shared/`, no exceptions"),
is deliberately **not** in this slice. It is the only rule that requires an
import graph, and the repository has no source parsing of any kind today —
no `tree-sitter`, `swc`, `oxc` or `ts-morph`, in either Cargo.toml or
package.json. Every existing check is substring matching over text or JSON
traversal. Shipping the cheap rules first proves the new plumbing (a
per-project scan target, a new command, finding identity for code findings)
before adding a new capability class on top of it. This is the book's own
advice from chapter 18: start simple, add complexity when the pain
justifies it.

## Decisions taken

| Question | Decision |
|---|---|
| Scope and trigger | Per project, on demand |
| Rule set for v1 | The substring-level rules; Scope Rule deferred |
| Noise control | Per-project rule toggles stored in CSK |
| Matching strategy | Substring with a lexical guard; no new dependency |

The matching decision follows an explicit convention of this repository.
`src-tauri/Cargo.toml` has no `regex` dependency, and `lib.rs:5850` states
the reason in the codebase's own words: "No `regex` crate (no extra dep)".
`skills_audit.rs` matches with substring tokens, not patterns. Adding a
regex dependency for the cheap rules would also contradict the argument
above for deferring the Scope Rule. All five rules in this slice are
expressible as substring tokens plus a boundary check.

## Where it lives

A new Rust command `audit_architecture(path: String)` registered in
`generate_handler!`. `validate_open_path()` is the mandatory gate, as it is
for every IPC entry point that touches a user-supplied path. The scan runs
under `spawn_blocking`, matching `run_audit`.

The trigger is a per-project button in `ProjectsView.tsx`, alongside the
existing "Open in VS Code" and "Open in TUI" actions on `ProjectListRow`.
The global `run_audit` is not modified.

## Output shape

The command returns `Vec<AuditFinding>` — the type that already exists. No
new finding type, no new view. Every finding carries `category: "ARCH"`.

`AuditView.tsx` buckets findings into a `Map<category, AuditFinding[]>`
derived from whatever category strings the Rust side emits, and renders one
section per category. The category filter chips are likewise derived from
the categories present. A new category value therefore renders with **zero
frontend changes** to the grouping and filtering code.

`level` follows the existing convention: `WARN` for a rule violation,
`INFO` for advisory findings such as a project with no `src/`.

## The scanner

The scanner walks the project directory, skipping `node_modules`, `dist`,
`build`, `target`, `.git` and `.next`. Version 1 reads `.ts`, `.tsx`, `.js`
and `.jsx` only.

For each file: read it, blank out comments and string literals, then apply
the enabled rules line by line to what remains.

### The lexical guard

The guard is the reason for that blanking step. Without it, `any` inside a
comment and the text `export *` inside a test fixture both produce
findings, and false positives are the failure mode that gets a linter
switched off.

It is a single character-state pass that replaces non-code spans with
spaces, preserving length and newlines so line numbers and column offsets
stay correct. States: code, line comment, block comment, single-quoted,
double-quoted, template literal.

Template literals need explicit handling because `${...}` returns to code:

- Inside a template literal, `${` pushes the code state and starts a brace
  counter at 1.
- While in that interpolation, `{` increments and `}` decrements the
  counter; reaching 0 pops back to the template literal.
- Interpolations nest, so the guard keeps a stack of counters rather than a
  single flag. Code inside `${}` is real code and must remain visible to
  the rules.

Escape sequences (`\"`, `` \` ``, `\\`) do not terminate their span. An
unterminated span at end of file blanks to the end rather than panicking.

### Rule representation

Rules are a static table, following `skills_audit.rs` (`BLOCKING_RULES` /
`WARN_RULES`) in spirit but with the fields this lens needs. Note that
`skills_audit.rs`'s own structs are `BlockingRule { rule, detail, all_of }`
and `WarnRule { rule, detail, needle }` — they have no `title`, because they
feed a different finding type. `AuditFinding` requires both `title` and
`detail`, so the new struct carries both:

```rust
struct ArchRule {
    /// Stable id, e.g. "arch/no-any". Persisted in toggles and finding ids.
    id: &'static str,
    /// AuditFinding.title
    title: &'static str,
    /// AuditFinding.detail prefix, before the path:line suffix.
    detail: &'static str,
    /// Every token must appear on the same guarded line, lowercased.
    all_of: &'static [&'static str],
    /// When set, the last token must not be followed by an identifier
    /// character. This is what separates `: any` from `: anything`.
    word_boundary: bool,
}
```

`all_of` is taken directly from `BlockingRule`: requiring every token on one
line is the existing device for cutting false positives, and it is what
lets `arch/storage-secret` demand both `localstorage.setitem` and a secret
token on the same line without a pattern language.

## Rules in v1

| Rule id | Tokens (`all_of`) | Boundary | Chapter |
|---|---|---|---|
| `arch/barrel-star` | `export *` — only in a file named `index.ts` | no | 13 |
| `arch/no-any` | `: any` / `as any` (two rule entries) | yes | 10 |
| `arch/effect-async` | `useeffect(async` | no | 9 |
| `arch/storage-secret` | `localstorage.setitem` + a secret keyword (`token`, `password`, `secret`) — three entries | no | 9 |
| `arch/type-folders` | not a text rule — see below | — | 18 |

Whitespace variants are normalized before matching: each guarded line is
lowercased, runs of spaces and tabs are collapsed to one space, and any
space immediately following `(` is then removed. That last step is load
bearing — collapsing runs is a no-op on a lone space, so without it
`useEffect( async () =>` stays `useeffect( async ...` and never matches.
With it, both `useEffect( async () =>` and `useEffect(async () =>` contain
the token `useeffect(async`.

`all_of` is AND-only: every token must appear on the same line. Alternation
is therefore expressed as several table entries sharing one id, never as a
pattern. `arch/no-any` is two entries (`: any`, `as any`) and
`arch/storage-secret` is three (one per secret keyword), all emitting their
shared rule id so that a toggle or an ignore applies to the whole rule.

`arch/type-folders` is a directory-shape rule, not a content rule. It fires
once per offending directory — `components/`, `hooks/` or `services/`
directly under `src/` — and never reads file contents or runs the guard.

## Rule toggles

A new file `~/.claude/csk-arch-rules.json`:

```json
{
  "version": 1,
  "projects": {
    "<canonical project path>": { "disabled": ["arch/no-any"] }
  }
}
```

Every rule is enabled by default; only disabled ids are persisted, so an
absent project entry means a full scan. Toggles are read before the walk
begins and a disabled rule is never executed, so turning rules off makes
the scan cheaper as well as quieter.

Two consequences are accepted rather than solved:

- The configuration lives in CSK, not in the audited repository, so it does
  not travel with the team and is not version-controlled. If that becomes
  a requirement, the migration path is exporting the toggles to a file in
  the repository later; the rule ids are stable and are the export format.
- Keying by canonical path means moving a project to a different directory
  loses its toggles. This matches how the rest of CSK identifies projects.

## Finding identity

`AuditFinding` (`lib.rs:992`) has no id. The ignore mechanism keys a finding
on the `(title, category, detail)` triple: `ignore_audit_finding` and
`unignore_audit_finding` (`lib.rs:7566`, `lib.rs:7596`) each take
`title, category, detail: String`, the persisted `IgnoredFinding`
(`lib.rs:7513`) stores exactly those three plus `ignored_at`, and
`run_audit_blocking` re-marks matching findings `ignored: true` on every
run.

That key does not survive code findings. A `detail` carrying `path:line`
changes whenever the file is edited above the offending line, which
silently un-ignores a finding the user already dismissed. Per-rule toggles
do not remove this: a user will still want to dismiss one instance of a
rule they otherwise want enabled.

The fix is an optional stable id, specified end to end:

1. `AuditFinding` gains `id: Option<String>`. Its TypeScript mirror in
   `src/types.ts` gains `id?: string`, and `src/lib/audit.ts` passes it
   through its normalization.
2. For architecture findings the id is a hex-encoded hash of
   `rule_id + "\0" + path relative to the project root + "\0" +
   the normalized matched line`. The eleven existing checks emit `None`
   and are otherwise untouched.
3. The line number is **deliberately excluded** from the hash. Moving code
   up or down within a file must not un-ignore it. Including the matched
   line keeps a genuinely different violation in the same file distinct.
4. `IgnoredFinding` gains `id: Option<String>`, defaulted with
   `#[serde(default)]` so existing `csk-audit-ignored.json` files
   deserialize unchanged.
5. `ignore_audit_finding` and `unignore_audit_finding` take one added
   parameter, `id: Option<String>`, and persist it when present.
6. Matching precedence when re-marking findings: if both the stored entry
   and the finding carry an id, compare ids only. Otherwise fall back to
   the `(title, category, detail)` triple. An id never matches a
   triple-only entry and vice versa.
7. The frontend call site is the `invoke(cmd, { ... })` block in
   `AuditView.tsx` (lines 311-315), which today passes exactly `title`,
   `category` and `detail`. It gains `id: finding.id`.
8. `findingKey` (`AuditView.tsx:27`) must incorporate `id` when present.
   It is currently `title::category` — two fields, not even the triple the
   Rust side uses — and it serves as both the React list key (lines 502
   and 747) and the in-flight state id in three handlers (lines 189, 272
   and 306). Architecture findings break that assumption: twenty
   `arch/no-any` violations in one project share a title and a category,
   so without an id they collapse into one React key and a single spinner
   would cover all of them. The comment at line 752 relies on the key
   being stable across resolves; an id-based key preserves that property,
   because the id excludes the line number.

Existing findings keep working unchanged and `csk-audit-ignored.json` needs
no migration, because the fallback path is the current behaviour.

## Error handling

A file that cannot be read does not abort the walk. It is skipped and
counted, and the count is reported as a single `INFO` finding when it is
non-zero, so a scan that silently read half the project is visible as such.

A project with no `src/` directory produces one `INFO` finding saying so,
rather than an empty result that reads as a clean bill of health.

A malformed `csk-arch-rules.json` enables every rule rather than failing
the scan, and reports one `INFO` finding naming the file.

## Testing

Strict TDD mode is enabled for this environment, so tests are written
first and must fail before any rule is implemented.

The four content rules each get a Rust unit test with three fixtures: a
true positive, a true negative, and the false positive the guard has to
swallow — the `any` inside a comment, the `export *` inside a string
literal. `arch/no-any` additionally covers the boundary case, asserting
that `: anything` does not fire.

`arch/type-folders` is excluded from that shape. It never runs the guard,
so it has no guard fixture; its tests are directory layouts — an offending
`src/components/`, a compliant feature-local `src/features/x/components/`,
and a project with no `src/`.

The guard gets its own tests independent of any rule: each span type, an
escaped quote that does not terminate its span, an unterminated span at end
of file, a single `${}` interpolation, and a nested one.

Toggle resolution is tested separately from the rules: a disabled rule
produces no findings, an absent project entry enables everything, and a
malformed toggles file falls back to enabling everything.

Finding identity gets tests for the property that motivates it: the same
violation at a different line number produces the same id, and a different
violation in the same file produces a different one.

Verification before delivery is `pnpm typecheck` and
`cargo check --manifest-path src-tauri/Cargo.toml`, plus `cargo test` for
the new rule tests.

## Out of scope

- The Scope Rule and any import-graph analysis.
- Languages other than TypeScript and JavaScript. The Go rules from
  chapter 4 apply to `tools/claudewatch`, and are a separate change.
- Auto-fix. Every rule in this slice reports only. `export *` cannot be
  rewritten to named re-exports without resolving the module, and
  `any` to `unknown` changes behaviour at every call site.
- Any change to `run_audit` or to the eleven existing checks, beyond the
  additive `id: Option<String>` field described above.

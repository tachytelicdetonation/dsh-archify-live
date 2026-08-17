# dsh-archify-live

A dsh (DeepSeek Harness) plugin that keeps a project's architecture diagram real, and
keeps it moving.

Two halves:

1. **Get the diagram authored.** A system-prompt section makes the agent check for
   `.dsh/architecture.json` before substantial work — building it from the code as it
   actually is when the project already exists, designing it first when the project is
   new, and updating it whenever a component is added, removed, or re-wired.
2. **Show what the session is doing to it.** A session-projection unit, `archifyTouched`,
   folds committed session events into the set of files the agent has actually edited.
   The client half maps those onto [archify](https://github.com/tt-a1i/archify) component
   ids, so a long agent run draws itself on the diagram as it goes.

The point is observability. An agent that writes a thousand lines you did not read is
legible as a picture long before it is legible as a diff.

## Why a projection and not a regenerated diagram

The obvious design — have the model redraw the architecture after each todo — certifies
nothing. A model redrawing its own work confirms its own story, and the diff is empty by
construction.

So the baseline IR is authored **once** and frozen. Only the *highlight* moves, and it is
derived from `tool/call` + `tool/result` pairs in the committed session log: a path counts
only when a mutation tool named it and the result did not come back `isError`. Reads,
greps and failed edits contribute nothing. Same vocabulary dsh's own deliverables row uses.

The highlight lives in the tab rather than in the diagram for a concrete reason: the
rendered page has no `postMessage` listener, and its `#focus=` deep link takes a single
node id. A live multi-component highlight cannot be pushed into a frozen artifact — only
re-rendered in, which is the move this design refuses.

Files no component claims are surfaced rather than swallowed — either the manifest is
stale or the session is working outside the architecture, and both are worth knowing.

## Layout

| file | role |
|---|---|
| `lib/touched.js` | the pure fold: session events → edited paths. Dependency-free. |
| `lib/index.js` | the Cordis plugin: manifest prompt section, `archifyTouched` projection unit, manifest RPC. |
| `lib/client.js` | the browser half: the Architecture tab, and the only implementation of path → component attribution. |
| `test/test.js` | `npm test` — synthetic legs plus a replay of a real recorded session. |

`lib/index.js` holds no I/O and no manifest reading on purpose: `apply` must be pure and
its state plain JSON, so resolving components belongs to the client half, not the fold.

## Install

The plugin row resolves a **bare specifier against the host composition**, not against the
preset directory — so the way to avoid an absolute path is to make this package a
dependency of the dsh profile:

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": {
  "dsh-archify-live": "github:<user>/dsh-archify-live"   // or file:../../../Projects/dsh-archify-live
}
```

Then the preset row is just:

```yaml
- id: archify-touched
  name: dsh-archify-live
```

During local development an absolute path works and skips the install step — the mount
converts it to a `file:` URL before import, so a plugin outside the harness's own
`node_modules` still loads:

```yaml
- id: archify-touched
  name: /Users/you/Projects/dsh-archify-live/lib/index.js
```

## Status

- [x] `archifyTouched` session projection, replayed against real session logs
- [x] path → component mapping via archify's `sources[]`
- [x] manifest prompt section — the agent authors and maintains the baseline itself
- [x] client half: a third `conversation.view` tab beside Chat and Trajectory
- [x] registration in a profile bundle, so it loads for every preset

## Rendering: strip `sources` first

archify reads `components[].sources` as a claim about a **pinned public GitHub revision**.
Their mere presence flips `verifyRepositoryEvidence` into mandatory mode, which then
hard-errors unless the manifest carries `meta.repository` with a `https://github.com/` URL
and a full 40-character SHA, *and* a matching local checkout is passed as `--repo-root`.
That is unsatisfiable for a private or local project, and the SHA goes stale every commit
even for a public one.

The trap is the error's own advice — `supportedFixes` says "remove component sources" — and
sources are exactly what attributes an edit to a component. So the manifest keeps them and
the render strips them:

```bash
jq 'del(.components[].sources)' .dsh/architecture.json > /tmp/arch-render.json
node bin/archify.mjs deliver architecture /tmp/arch-render.json .dsh/architecture.html \
  --quality showcase --json
```

The prompt section tells the agent this directly, because the failure is otherwise silent:
a compliant agent deletes the sources and the tab goes permanently dark.

## Known limits

- **Cumulative per session, not per turn.** Unlike dsh's todo projection, the touched set
  does not clear on `turn/start`. A long session accumulates; that is the intent.
- **Import-blind.** Editing a file lights its component. Coupling that is not a file edit
  — a shared table, a queue topic, an env var — is invisible here.
- **`sources` is capped at 3 entries** by archify's schema, and it is citation rather than
  ownership. Directory-level sources work (prefix matching is segment-aware), but a
  component owning many scattered files cannot say so.

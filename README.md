# dsh-archify-live

A dsh (DeepSeek Harness) plugin that answers one question, from evidence:

> **which files has this session actually edited?**

It registers a single session-projection unit, `archifyTouched`. The client half maps
those paths onto an [archify](https://github.com/tt-a1i/archify) architecture IR and
lights up the components they belong to, so a long agent run draws itself on the
architecture diagram as it goes.

## Why a projection and not a regenerated diagram

The obvious design — have the model redraw the architecture after each todo — certifies
nothing. A model redrawing its own work confirms its own story, and the diff is empty by
construction.

So the baseline IR is authored **once** and frozen. Only the *focus set* moves, and it is
derived from `tool/call` + `tool/result` pairs in the committed session log: a path counts
only when a mutation tool named it and the result did not come back `isError`. Reads,
greps and failed edits contribute nothing. Same vocabulary dsh's own deliverables row uses.

Files no component claims are surfaced rather than swallowed — either the manifest is
stale or the session is working outside the architecture, and both are worth knowing.

## Layout

| file | role |
|---|---|
| `lib/touched.js` | the pure fold: session events → edited paths. Dependency-free. |
| `lib/focus.js` | pure mapping: edited paths + IR → a `touched` guided view. |
| `lib/index.js` | the Cordis plugin: registers the `archifyTouched` projection unit. |
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
- [x] path → component mapping via archify's `sources[]`, expressed as a guided view
- [ ] client half: a third `conversation.view` tab beside Chat and Trajectory
- [ ] move the registration into a profile bundle, so it loads for every preset and the
      preset copy goes away

## Known limits

- **Cumulative per session, not per turn.** Unlike dsh's todo projection, the touched set
  does not clear on `turn/start`. A long session accumulates; that is the intent.
- **Import-blind.** Editing a file lights its component. Coupling that is not a file edit
  — a shared table, a queue topic, an env var — is invisible here.
- **`sources` is capped at 3 entries** by archify's schema, and it is citation rather than
  ownership. Directory-level sources work (prefix matching is segment-aware), but a
  component owning many scattered files cannot say so.

/**
 * Which files has this session actually edited?
 *
 * Registers one session-projection unit, `archifyTouched`, folding committed session
 * events into the set of successfully mutated paths. The framework owns the drive,
 * the replay, the cache and the push to the browser; this module owns only the
 * mathematics — three pure synchronous functions, per the session-projection contract.
 *
 * Deliberately NOT here: reading the architecture manifest or resolving paths to
 * components. `apply` must be pure and its state plain JSON, so manifest I/O would
 * break the seam. The client half does that mapping with `./focus.js`.
 *
 * @module dsh-archify-live
 */

import { z } from 'zod'

import { DEFAULT_MUTATION_TOOLS, apply as fold, init } from './touched.js'

export const name = 'archify-touched'
export const inject = []

/** Wire payload: the paths, in first-touched order. */
const touchedProjectionSchema = z.object({
  touched: z.array(z.string())
})

/** Bump whenever the state shape or the fold semantics change.
 *  2 — `str_replace_editor view` no longer counts as an edit; v1 rows over-report. */
const STATE_VERSION = 2

/** Where a workspace keeps its architecture manifest. `.dsh/` is already a project-level
 *  dsh directory (it is the rank-100 skill root), so the manifest belongs beside it. */
export const MANIFEST_PATH = '.dsh/architecture.json'

/**
 * The trigger. Without this the projection has nothing to light up: highlighting
 * assumes a manifest someone already authored, and nobody ever authors one.
 *
 * Static rather than a provider that stats the file, because `PromptContext`
 * providers are synchronous and receive only `{ scope, signal }` — no workspace
 * path — so the agent is the thing that can actually check. Static text also keeps
 * the prompt prefix stable, which keeps the KV cache warm.
 */
const ARCHITECTURE_PROMPT = `## Architecture manifest

This workspace keeps a machine-checkable architecture description at \`${MANIFEST_PATH}\`:
an archify \`architecture\` IR whose components carry \`sources\` entries naming the
directories they own.

Before substantial work in a codebase, check whether that file exists.

- **Missing, and the project has code** — build it from the code as it actually is, using
  the \`archify\` skill. Read the real entry points, module boundaries and storage before
  drawing; a diagram of what you assume is worse than none. Give every component a
  \`sources\` path so edits can be attributed back to it.
- **Missing, and the project is new** — design it first, agree it, then build to it.
- **Present** — read it before planning. It is the fastest description of the system you
  will get, and it is what the session's live component highlighting is drawn against.

Update it in the same change that adds, removes, or re-wires a component. Do not update it
for edits that only alter behaviour inside an existing component.`

/**
 * Register the two halves: the prompt section that gets a manifest authored, and the
 * projection unit that tracks what the session then does to it.
 *
 * Both seams are optional capabilities (`ctx.inject`), so a headless assembly composing
 * neither stays unaffected rather than failing to load.
 *
 * No `Config` export: the mutation-tool vocabulary is a property of dsh's own tool
 * set, not a deployment choice, and a config schema here would mean a second copy of
 * schemastery resolved from outside the harness.
 *
 * @param ctx - registrant context.
 */
export function apply (ctx) {
  const mutationTools = DEFAULT_MUTATION_TOOLS

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'archify:architecture-manifest',
      order: 180,
      text: ARCHITECTURE_PROMPT
    })
  })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'archifyTouched',
      schema: touchedProjectionSchema,
      init,
      apply: (state, event) => fold(state, event, mutationTools),
      // `pending` is bookkeeping; the browser only ever needs the settled set.
      view: (state) => ({ touched: state.touched }),
      stateVersion: STATE_VERSION
    })
  })
}

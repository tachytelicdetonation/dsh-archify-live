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
 * Static, and deliberately self-contained — it names no skill and no tool, so it
 * cannot dangle when `archify` is not installed. The rendering step is optional; the
 * manifest is the artifact that matters, and it is plain JSON either way.
 *
 * A dynamic `systemPrompt.context` provider that stats the manifest and stays silent
 * when present would cost less prompt, but the "read it first, update it when you
 * re-wire" half has to survive the manifest existing — so most of this text would
 * stay always-on regardless. Static also keeps the prompt prefix KV-cache stable.
 */
const ARCHITECTURE_PROMPT = `## Architecture manifest

This workspace keeps a machine-readable architecture description at \`${MANIFEST_PATH}\` —
an archify \`architecture\` IR. Every component carries \`sources\` entries naming the
directories it owns, which is what attributes an edit back to a component.

Before substantial work, check whether that file exists.

- **Missing, project has code** — build it from the code as it actually is. Read the real
  entry points, module boundaries and storage first; a diagram of what you assumed is
  worse than none.
- **Missing, project is new** — design it, agree it, then build to it.
- **Present** — read it before planning. It is the fastest description of the system you
  will get, and the session's live component highlighting is drawn against it.

Update it in the same change that adds, removes, or re-wires a component — not for edits
that only alter behaviour inside one. Render it with the \`archify\` skill when available.`

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

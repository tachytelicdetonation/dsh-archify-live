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

/** Bump whenever the state shape or the fold semantics change. */
const STATE_VERSION = 1

/**
 * Register the `archifyTouched` unit when the session-projection seam is composed.
 *
 * No `Config` export: the mutation-tool vocabulary is a property of dsh's own tool
 * set, not a deployment choice, and a config schema here would mean a second copy of
 * schemastery resolved from outside the harness.
 *
 * @param ctx - registrant context.
 */
export function apply (ctx) {
  const mutationTools = DEFAULT_MUTATION_TOOLS

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

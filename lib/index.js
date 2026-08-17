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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { DEFAULT_MUTATION_TOOLS, apply as fold, init } from './touched.js'

export const name = 'archify-touched'
export const inject = []

/** Logical RPC channel serving the workspace's manifest to the browser half. */
export const CHANNEL = '/archify'

/** Rendered diagram, when the agent has produced one beside the manifest. */
export const RENDER_PATH = '.dsh/architecture.html'

/** A self-contained archify page can be large; past this we serve the manifest alone
 *  and the tab falls back to its component list rather than pushing megabytes. */
const MAX_RENDER_BYTES = 4 * 1024 * 1024

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
  will get, and the Architecture tab highlights its components against your edits.

Update it in the same change that adds, removes, or re-wires a component — not for edits
that only alter behaviour inside one. Render it to \`${RENDER_PATH}\` with the \`archify\`
skill when that skill is available; the tab shows the rendered page when it exists.`

const rpcError = (code, message) => ({ ok: false, error: { code, message, details: { issues: [] } } })

/** The session's workspace root, however this dsh version exposes it. */
const rootOf = (session) => session?.cwd ?? session?.header?.cwd ?? session?.meta?.cwd

async function readIfPresent (file, maxBytes = Infinity) {
  try {
    const text = await readFile(file, 'utf8')
    return text.length > maxBytes ? undefined : text
  } catch {
    return undefined // absent is normal state, not an error
  }
}

/**
 * Serve the workspace's manifest and rendered diagram to the browser half.
 *
 * The client sends only a `sessionId` — never a path — so the reachable set is exactly
 * "two fixed filenames under a session's own workspace root", with no traversal surface
 * to validate. A missing or unparsable manifest is a successful empty answer, because
 * "no manifest yet" is the state the tab most needs to render well.
 */
export function createManifestHandler (ctx) {
  return async (endpoint, payload, signal) => {
    if (endpoint !== 'manifest') return rpcError('not-found', `unknown endpoint ${endpoint}`)

    const root = rootOf(ctx.sessions.get(payload?.sessionId))
    if (!root) return { ok: true, value: { root: null, manifest: null, render: null } }

    try {
      signal?.throwIfAborted()
      const text = await readIfPresent(join(root, MANIFEST_PATH))
      let manifest = null
      try { manifest = text === undefined ? null : JSON.parse(text) } catch { manifest = null }
      const render = manifest ? await readIfPresent(join(root, RENDER_PATH), MAX_RENDER_BYTES) : undefined
      return { ok: true, value: { root, manifest, render: render ?? null } }
    } catch (error) {
      if (signal?.aborted) throw error
      return rpcError('internal', 'Could not read the architecture manifest')
    }
  }
}

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

  ctx.inject(['connection', 'sessions'], (rpcCtx) => {
    rpcCtx.effect(
      () => rpcCtx.connection.rpc.handle(CHANNEL, createManifestHandler(rpcCtx), { authority: 'loopback' }),
      'archify: workspace manifest RPC'
    )
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

/**
 * The pure fold: committed session events → the set of files this session edited.
 *
 * Dependency-free on purpose. The Cordis registration in `./index.js` wraps these,
 * but the mathematics is testable by replaying a recorded session log through it —
 * which is exactly what `test/test.js` does.
 */

export const DEFAULT_MUTATION_TOOLS = ['write', 'edit', 'str_replace_editor']

/** State for the empty log. `pending` pairs a call with its result across events. */
export const init = () => ({ pending: {}, touched: [] })

const pathOf = (args) => args?.file_path ?? args?.path ?? null

/**
 * Pure transition: previous state + one committed event → next state.
 *
 * Returns the SAME reference for events this unit does not care about — the drive
 * gates its change feed on `Object.is`, and a session is mostly reasoning chunks.
 */
export function apply (state, event, mutationTools = DEFAULT_MUTATION_TOOLS) {
  if (event.type === 'tool/call') {
    if (!mutationTools.includes(event.data?.name)) return state
    let args
    try { args = JSON.parse(event.data.arguments ?? '{}') } catch { return state }
    const path = pathOf(args)
    if (!path) return state
    return { ...state, pending: { ...state.pending, [event.data.callId]: path } }
  }

  if (event.type === 'tool/result') {
    let next = null
    for (const part of event.data?.message?.content ?? []) {
      const callId = part?.toolCallId
      if (!callId || !(callId in state.pending)) continue
      next ??= { pending: { ...state.pending }, touched: [...state.touched] }
      const path = next.pending[callId]
      delete next.pending[callId]
      // A failed edit changed nothing; only successes are evidence.
      if (!part.isError && !next.touched.includes(path)) next.touched.push(path)
    }
    return next ?? state
  }

  return state
}

/** Fold a whole log at once — replay, tests, and cold reads. */
export function fold (events, mutationTools = DEFAULT_MUTATION_TOOLS) {
  let state = init()
  for (const event of events) state = apply(state, event, mutationTools)
  return state
}

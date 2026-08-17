/**
 * Browser half: an "Architecture" tab beside Chat and Trajectory.
 *
 * Hand-written in the lazy-CJS form the client module loader expects
 * (`window.__ModuleLoader__.load({id, factory})`, per dsh-client-modules) and using
 * `react.createElement` rather than JSX, so this package ships with no build step.
 * Everything lives in the factory closure; nothing runs at script execution.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archify-live',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const h = react.createElement

    const CHANNEL = '/archify'

    // ── path matching ────────────────────────────────────────────────────────
    // The only implementation of attribution. It lives here rather than host-side
    // because the highlight has to move with every pushed projection frame, and the
    // rendered diagram is a frozen artifact — nothing on the host can restyle it.

    const normalize = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '')

    function pathMatches (file, source) {
      const f = normalize(file)
      const s = normalize(source)
      return f === s || f.startsWith(s + '/')
    }

    function relativize (file, root) {
      if (!root) return file
      const prefix = normalize(root) + '/'
      return file.startsWith(prefix) ? file.slice(prefix.length) : file
    }

    /** Split edited files into the components that claim them, and the ones nobody does. */
    function attribute (manifest, touched, root) {
      const files = touched.map((file) => relativize(file, root))
      const claimed = new Set()

      const components = (manifest?.components ?? []).map((component) => {
        const sources = component.sources ?? []
        const hits = files.filter((file) => sources.some((s) => s.path && pathMatches(file, s.path)))
        hits.forEach((file) => claimed.add(file))
        return { ...component, hits }
      })

      return { components, unmapped: files.filter((file) => !claimed.has(file)) }
    }

    // ── view ─────────────────────────────────────────────────────────────────

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', overflow: 'auto', height: '100%' },
      frame: { width: '100%', minHeight: '420px', border: '1px solid var(--dsh-border, #3a3a3a)', borderRadius: '8px', background: '#fff' },
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 0' },
      dot: (lit) => ({
        width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
        background: lit ? 'var(--dsh-accent, #7c9cff)' : 'var(--dsh-border, #4a4a4a)'
      }),
      label: (lit) => ({ fontWeight: lit ? 600 : 400, opacity: lit ? 1 : 0.6 }),
      files: { fontSize: '12px', opacity: 0.7, marginLeft: 'auto', textAlign: 'right' },
      note: { fontSize: '13px', opacity: 0.7, lineHeight: 1.5 },
      head: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.55 }
    }

    function Empty (props) {
      return h('div', { style: styles.wrap },
        h('div', { style: styles.head }, 'Architecture'),
        h('p', { style: styles.note }, props.message))
    }

    function ComponentRow (component) {
      const lit = component.hits.length > 0
      return h('div', { key: component.id, style: styles.row },
        h('span', { style: styles.dot(lit) }),
        h('span', { style: styles.label(lit) }, component.label || component.id),
        lit ? h('span', { style: styles.files }, component.hits.join(', ')) : null)
    }

    function ArchitectureView (props) {
      const useProjection = props.useProjection
      const sessionId = props.sessionId
      const rpc = props.rpc

      const projection = useProjection('archifyTouched')
      const touched = projection?.touched ?? []

      const [state, setState] = react.useState({ status: 'loading' })

      // The manifest is workspace state, not session state: fetch once per session and
      // let the projection — which is pushed — drive every subsequent repaint.
      react.useEffect(() => {
        let live = true
        const controller = new AbortController()
        rpc.call(CHANNEL, 'manifest', { sessionId }, controller.signal).then(
          (result) => {
            if (!live) return
            setState(result.ok
              ? { status: 'ready', ...result.value }
              : { status: 'error', message: result.error?.message ?? 'Request failed' })
          },
          () => { if (live) setState({ status: 'error', message: 'Could not reach the host' }) }
        )
        return () => { live = false; controller.abort() }
      }, [rpc, sessionId])

      if (state.status === 'loading') return h(Empty, { message: 'Loading…' })
      if (state.status === 'error') return h(Empty, { message: state.message })
      if (!state.manifest) {
        return h(Empty, {
          message: 'No architecture manifest yet. Ask the agent to build one at .dsh/architecture.json — ' +
            'it will read the real entry points and boundaries first, then draw.'
        })
      }

      const { components, unmapped } = attribute(state.manifest, touched, state.root)
      const litCount = components.filter((c) => c.hits.length > 0).length

      return h('div', { style: styles.wrap },
        state.render
          ? h('iframe', {
            style: styles.frame,
            srcDoc: state.render,
            // The rendered page is generated from this workspace's own manifest, but it
            // is still authored content — keep it from reaching back into the app.
            sandbox: 'allow-scripts',
            title: 'Architecture diagram'
          })
          : null,
        state.stale
          ? h('p', { style: styles.note },
            'The diagram is older than the manifest — it was rendered before the most ' +
            'recent edit to .dsh/architecture.json. The component list below is current; ' +
            'the picture may not be.')
          : null,
        h('div', { style: styles.head },
          `Touched this session — ${litCount} of ${components.length} components, ${touched.length} files`),
        components.map(ComponentRow),
        unmapped.length
          ? h('p', { style: styles.note },
            `${unmapped.length} edited file${unmapped.length === 1 ? '' : 's'} no component claims: ` +
            `${unmapped.join(', ')}. Either the manifest is stale, or this work sits outside the architecture.`)
          : null)
    }

    // ── registration ─────────────────────────────────────────────────────────

    const inject = ['slots', 'connection']

    function apply (ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'architecture',
        order: 20, // after trajectory (10)
        label: () => 'Architecture',
        inject: (sessionId) => ({ sessionId, rpc: ctx.connection.rpc })
      }, ArchitectureView))
    }

    exports.ArchitectureView = ArchitectureView
    exports.attribute = attribute
    exports.pathMatches = pathMatches
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

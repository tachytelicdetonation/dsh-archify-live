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

    // ── the rendered page ────────────────────────────────────────────────────

    /**
     * Archify's shipped panel chrome. `html[data-embed="true"]` hides the toolbar,
     * header, cards, nav and overview map; its own bootstrap sets that from `?embed=1`,
     * which a srcDoc document cannot have. An attribute rather than an injected script,
     * so it applies before first paint.
     */
    const embedify = (html) => html.replace('<html ', '<html data-embed="true" ')

    /**
     * Make the diagram follow dsh's theme instead of the OS.
     *
     * Setting `data-theme` the way `embedify` sets `data-embed` does not work: the page's
     * head bootstrap and its toolbar module both re-resolve the theme at load and
     * overwrite the attribute. But both resolutions bottom out in the *same* expression,
     * so replacing that expression's value is what actually sticks.
     */
    const themify = (html, scheme) => html.replaceAll(
      "window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'",
      `'${scheme === 'light' ? 'light' : 'dark'}'`)

    /**
     * Embed mode sets `overflow: hidden` on the page body and the template has no wheel
     * zoom, so anything past the iframe's height is not scrolled — it is unreachable.
     * Size the frame to the diagram's own aspect ratio instead of a fixed height, and let
     * our own scroll container handle a tall one. `+64` leaves room for the legend.
     */
    function frameAspect (html) {
      const match = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html || '')
      if (!match) return null
      const [w, hgt] = [Number(match[1]), Number(match[2])]
      return w > 0 && hgt > 0 ? `${w} / ${hgt + 64}` : null
    }

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
    function attribute (manifest, touched, root, deadSources = {}) {
      const files = touched.map((file) => relativize(file, root))
      const claimed = new Set()

      const components = (manifest?.components ?? []).map((component) => {
        const sources = component.sources ?? []
        const hits = files.filter((file) => sources.some((s) => s.path && pathMatches(file, s.path)))
        hits.forEach((file) => claimed.add(file))
        return { ...component, hits, dead: deadSources[component.id] ?? [] }
      })

      return { components, unmapped: files.filter((file) => !claimed.has(file)) }
    }

    // ── view ─────────────────────────────────────────────────────────────────

    // Real dsh design tokens (`--dsw-alias-*`). An earlier version invented
    // `--dsh-border`/`--dsh-accent`, which exist nowhere, so every colour was silently
    // the hardcoded fallback and drifted from the app on any theme change.
    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', overflow: 'auto', height: '100%' },
      frame: {
        width: '100%',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)'
      },
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 0' },
      dot: (lit) => ({
        width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
        background: lit ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'
      }),
      label: (lit) => ({
        fontWeight: lit ? 600 : 400,
        color: lit ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)'
      }),
      files: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto', textAlign: 'right' },
      note: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      dead: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', marginLeft: 'auto', textAlign: 'right' },
      head: {
        fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--dsw-alias-label-tertiary)'
      }
    }

    function Empty (props) {
      return h('div', { style: styles.wrap },
        h('div', { style: styles.head }, 'Architecture'),
        h('p', { style: styles.note }, props.message))
    }

    function ComponentRow (component) {
      const lit = component.hits.length > 0
      const dead = component.dead ?? []
      return h('div', { key: component.id, style: styles.row },
        h('span', { style: styles.dot(lit) }),
        h('span', { style: styles.label(lit) }, component.label || component.id),
        dead.length
          // A component that claims a path which no longer exists can never light up.
          // Say so on the row itself — silence here is what lets the manifest rot.
          ? h('span', { style: styles.dead }, `missing: ${dead.join(', ')}`)
          : lit ? h('span', { style: styles.files }, component.hits.join(', ')) : null)
    }

    function ArchitectureView (props) {
      const useProjection = props.useProjection
      const sessionId = props.sessionId
      const rpc = props.rpc
      const theme = props.theme

      const projection = useProjection('archifyTouched')
      const touched = projection?.touched ?? []

      const [state, setState] = react.useState({ status: 'loading' })

      // Follow dsh's theme, and keep following it: a toggle re-derives srcDoc, which
      // reloads the iframe. Cheaper than re-fetching the manifest for a colour change.
      const [scheme, setScheme] = react.useState(() => theme.current())
      react.useEffect(() => theme.subscribe(setScheme), [theme])

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

      const { components, unmapped } = attribute(state.manifest, touched, state.root, state.deadSources)
      const litCount = components.filter((c) => c.hits.length > 0).length
      const deadCount = components.filter((c) => c.dead.length > 0).length

      const page = state.render ? themify(embedify(state.render), scheme) : null
      const aspect = frameAspect(state.render)

      return h('div', { style: styles.wrap },
        page
          ? h('iframe', {
            // Fall back to a tall-ish box only when the viewBox is unreadable; a fixed
            // height would silently amputate the diagram, since embed mode cannot scroll.
            style: aspect ? { ...styles.frame, aspectRatio: aspect } : { ...styles.frame, height: '70vh' },
            srcDoc: page,
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
          : null,
        deadCount
          ? h('p', { style: styles.note },
            `${deadCount} component${deadCount === 1 ? '' : 's'} claim a path that no longer exists, ` +
            'so nothing can ever light them up. Ask the agent to update .dsh/architecture.json.')
          : null)
    }

    // ── registration ─────────────────────────────────────────────────────────

    const inject = ['slots', 'connection', 'theme']

    function apply (ctx) {
      // `ctx.theme` is the resolved snapshot (`system` is already collapsed to a real
      // scheme); `theme/change` is the continuous-sync channel, same as ui-layout uses.
      const theme = {
        current: () => ctx.theme.getTheme().active.colorScheme,
        subscribe: (fn) => ctx.on('theme/change', (snapshot) => fn(snapshot.active.colorScheme))
      }

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'architecture',
        order: 20, // after trajectory (10)
        label: () => 'Architecture',
        inject: (sessionId) => ({ sessionId, rpc: ctx.connection.rpc, theme })
      }, ArchitectureView))
    }

    exports.ArchitectureView = ArchitectureView
    exports.attribute = attribute
    exports.pathMatches = pathMatches
    exports.embedify = embedify
    exports.themify = themify
    exports.frameAspect = frameAspect
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})

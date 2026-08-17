// One runnable check: replay a real recorded dsh session through the fold, and
// assert the pure pieces. Run with `npm test`.
//
// The recorded-session leg is skipped when no dsh sessions exist on this machine —
// the synthetic legs still fail loudly if the fold or the mapping breaks.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { pathMatches, touchedComponents, withTouchedView, VIEW_ID } from '../lib/focus.js'
import { apply, fold, init } from '../lib/touched.js'

// ── fold ────────────────────────────────────────────────────────────────────

const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
const result = (callId, isError = false) => ({ type: 'tool/result', data: { message: { content: [{ toolCallId: callId, isError }] } } })

{
  const state = fold([
    call('a', 'edit', { file_path: '/repo/src/one.py' }),
    result('a'),
    call('b', 'write', { file_path: '/repo/src/two.py' }),
    result('b'),
    call('c', 'edit', { file_path: '/repo/src/bad.py' }),
    result('c', true), // failed edit changed nothing
    call('d', 'read', { file_path: '/repo/src/three.py' }), // reads are not evidence
    result('d')
  ])
  assert.deepEqual(state.touched, ['/repo/src/one.py', '/repo/src/two.py'], 'only successful mutations count')
  assert.deepEqual(state.pending, {}, 'settled calls leave no bookkeeping behind')
}

{
  // The Object.is contract: an uninteresting event must not allocate.
  const before = init()
  assert.equal(apply(before, { type: 'reasoning-chunks', data: {} }), before, 'same reference for foreign events')
  assert.equal(apply(before, call('x', 'read', { file_path: '/a' })), before, 'same reference for non-mutation calls')
  const pending = apply(before, call('y', 'edit', { file_path: '/a' }))
  assert.notEqual(pending, before, 'a mutation call does allocate')
}

{
  // A duplicated path must not appear twice.
  const state = fold([call('a', 'edit', { file_path: '/r/x' }), result('a'), call('b', 'edit', { file_path: '/r/x' }), result('b')])
  assert.deepEqual(state.touched, ['/r/x'], 'first-touched order, no duplicates')
}

// ── mapping ─────────────────────────────────────────────────────────────────

assert.ok(pathMatches('src/a/b.py', 'src/a'), 'a directory source claims files under it')
assert.ok(pathMatches('src/a.py', 'src/a.py'), 'an exact file source matches itself')
assert.ok(!pathMatches('src/ab.py', 'src/a'), 'prefix matching respects path segments')

const ir = {
  components: [
    { id: 'suite', type: 'service', label: 'Ratify suite', sources: [{ path: 'ratify_suite' }] },
    { id: 'docs', type: 'store', label: 'Notes', sources: [{ path: 'notes' }] },
    { id: 'nosrc', type: 'service', label: 'Unmapped' }
  ]
}

{
  const ids = touchedComponents(ir, ['/repo/ratify_suite/conftest.py', '/repo/README.md'], '/repo')
  assert.deepEqual(ids, ['suite'], 'absolute paths resolve against the repo root; unclaimed files light nothing')
}

{
  const { meta } = withTouchedView(ir, ['suite', 'docs'], { note: 'x'.repeat(200) })
  const view = meta.views.find((v) => v.id === VIEW_ID)
  assert.deepEqual(view.focus, ['suite', 'docs'])
  assert.equal(view.note.length, 140, 'note is clipped to the schema maximum')
}

{
  const withView = withTouchedView(ir, ['suite'])
  const cleared = withTouchedView(withView, [])
  assert.equal(cleared.meta.views, undefined, 'an empty focus set removes the view (schema: focus minItems 1)')
}

{
  // The baseline may already spend the 5-view budget; ours leads and the oldest drops.
  const busy = { ...ir, meta: { views: [1, 2, 3, 4, 5].map((n) => ({ id: `v${n}`, label: `v${n}`, focus: ['suite'] })) } }
  const { meta } = withTouchedView(busy, ['docs'])
  assert.equal(meta.views.length, 5, 'stays within maxItems')
  assert.equal(meta.views[0].id, VIEW_ID, 'the live view is never the one dropped')
}

// ── recorded session ────────────────────────────────────────────────────────

function sessionLogsNewestFirst () {
  const root = join(homedir(), '.dsh', 'sessions')
  const found = []
  for (const slug of readdirSync(root)) {
    for (const session of readdirSync(join(root, slug))) {
      const file = join(root, slug, session, 'session.jsonl.zstd')
      try { found.push({ file, mtime: statSync(file).mtimeMs }) } catch { /* absent */ }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.file)
}

const readEvents = (file) => execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 512 << 20 })
  .split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)

// Independent scan that ignores results entirely: the vocabulary the fold must not
// exceed. A session with none of these is a read-only session — legitimate, and not
// something to assert against, so keep looking for one that actually edited files.
function namedPaths (events) {
  const named = new Set()
  for (const event of events) {
    if (event.type !== 'tool/call' || !['write', 'edit'].includes(event.data?.name)) continue
    try { named.add(JSON.parse(event.data.arguments).file_path) } catch { /* unparsable */ }
  }
  return named
}

let checked = null
let logs = []
try { logs = sessionLogsNewestFirst() } catch { /* no dsh on this machine */ }

for (const log of logs.slice(0, 20)) {
  const events = readEvents(log)
  const named = namedPaths(events)
  if (!named.size) continue

  const state = fold(events)
  for (const path of state.touched) assert.ok(named.has(path), `${path} was never named by a mutation call`)
  assert.ok(state.touched.length <= named.size, 'the fold never invents a path')
  assert.deepEqual(state.pending, {}, 'a finished session leaves no unpaired calls')

  checked = `${state.touched.length} files touched of ${named.size} named, over ${events.length} events`
  break
}

console.log(checked
  ? `recorded session: ${checked}`
  : 'recorded-session leg skipped: no dsh session with file mutations found')

console.log('ok')

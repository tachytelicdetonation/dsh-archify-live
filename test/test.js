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

import { MANIFEST_PATH, apply as register } from '../lib/index.js'
import { apply, fold, init } from '../lib/touched.js'

// ── registration ────────────────────────────────────────────────────────────

{
  // Both seams are optional capabilities; a deployment composing only one must still load.
  const seen = []
  const ctx = (available) => ({
    inject (deps, fn) {
      if (!deps.every((d) => available.includes(d))) return
      seen.push(deps[0])
      fn({
        systemPrompt: { section: (s) => seen.push(`section:${s.name}`) },
        sessionProjections: { register: (d) => seen.push(`unit:${d.key}`) }
      })
    }
  })

  register(ctx(['systemPrompt', 'sessionProjections']))
  assert.ok(seen.includes('section:archify:architecture-manifest'), 'contributes the manifest prompt section')
  assert.ok(seen.includes('unit:archifyTouched'), 'contributes the projection unit')

  seen.length = 0
  register(ctx(['sessionProjections'])) // headless: no system prompt registry
  assert.deepEqual(seen, ['sessionProjections', 'unit:archifyTouched'], 'survives a missing prompt seam')

  assert.equal(MANIFEST_PATH, '.dsh/architecture.json')
}

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
  // `str_replace_editor` is a file tool, not a mutation tool: `view` is a read.
  const state = fold([
    call('a', 'str_replace_editor', { command: 'view', path: '/r/looked-at.py' }),
    result('a'),
    call('b', 'str_replace_editor', { command: 'str_replace', path: '/r/edited.py', old_str: 'x', new_str: 'y' }),
    result('b'),
    call('c', 'str_replace_editor', { command: 'create', path: '/r/made.py' }),
    result('c'),
    call('d', 'str_replace_editor', { command: 'insert', path: '/r/inserted.py', insert_line: 1 }),
    result('d')
  ])
  assert.deepEqual(state.touched, ['/r/edited.py', '/r/made.py', '/r/inserted.py'], 'view is not an edit')
}

{
  // A duplicated path must not appear twice.
  const state = fold([call('a', 'edit', { file_path: '/r/x' }), result('a'), call('b', 'edit', { file_path: '/r/x' }), result('b')])
  assert.deepEqual(state.touched, ['/r/x'], 'first-touched order, no duplicates')
}

// ── client bundle ───────────────────────────────────────────────────────────

const ir = {
  components: [
    { id: 'suite', type: 'service', label: 'Ratify suite', sources: [{ path: 'ratify_suite' }] },
    { id: 'docs', type: 'store', label: 'Notes', sources: [{ path: 'notes' }] },
    { id: 'nosrc', type: 'service', label: 'Unmapped' }
  ]
}

{
  // Load the browser bundle in Node by standing in for the client module loader, so the
  // duplicated matcher inside it cannot silently drift from lib/focus.js.
  let client
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        assert.equal(id, 'dsh-archify-live', 'bundle id must be the package name')
        client = factory((name) => {
          if (name === 'react') return { createElement: () => null, useState: () => [], useEffect: () => {} }
          throw new Error(`client bundle required an unstubbed module: ${name}`)
        })
      }
    }
  }
  await import('../lib/client.js')
  delete globalThis.window

  assert.deepEqual(client.inject, ['slots', 'connection', 'theme'])
  assert.equal(typeof client.apply, 'function')

  // The rendered page is transformed three ways before it reaches the iframe. Each of
  // these is pinned to a string archify actually ships, so an upstream rename fails here
  // rather than silently degrading the panel.
  {
    const page = '<!DOCTYPE html>\n<html lang="en" data-theme="dark">\n<head>'
    assert.match(client.embedify(page), /<html data-embed="true" lang="en"/, 'sets the attribute the embed CSS keys on')
    assert.equal(client.embedify('<html>x</html>'), '<html>x</html>', 'leaves an unexpected shape alone rather than corrupting it')
  }
  {
    // Both of archify's theme-resolution sites end in this exact expression; replacing
    // its value is the only thing that survives its own bootstrap overwriting the attribute.
    const probe = "theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';"
    assert.equal(client.themify(probe, 'dark'), "theme = 'dark';", 'pins the scheme dsh is actually using')
    assert.equal(client.themify(probe, 'light'), "theme = 'light';")
    assert.ok(!client.themify(probe, 'dark').includes('matchMedia'), 'no OS fallback survives')
  }
  {
    // Embed mode sets overflow:hidden and there is no wheel zoom, so a too-short frame
    // amputates the diagram. The frame must take its height from the diagram's own ratio.
    assert.equal(client.frameAspect('<svg viewBox="0 0 1040 648">'), '1040 / 712', 'aspect from viewBox, plus legend allowance')
    assert.equal(client.frameAspect('<svg>'), null, 'no viewBox means fall back rather than guess')
  }

  assert.ok(client.pathMatches('src/a/b.py', 'src/a'), 'a directory source claims files under it')
  assert.ok(client.pathMatches('src/a.py', 'src/a.py'), 'an exact file source matches itself')
  assert.ok(!client.pathMatches('src/ab.py', 'src/a'), 'prefix matching respects path segments')

  // Attribution over absolute paths, which is what the projection actually reports.
  const absolute = ['/repo/ratify_suite/conftest.py', '/repo/notes/x.md', '/repo/stray.txt']
  const { components, unmapped } = client.attribute(ir, absolute, '/repo')
  assert.deepEqual(components.filter((c) => c.hits.length).map((c) => c.id), ['suite', 'docs'],
    'absolute paths resolve against the repo root')
  assert.deepEqual(components.find((c) => c.id === 'nosrc').hits, [], 'a component with no sources never lights')
  assert.deepEqual(unmapped, ['stray.txt'], 'files no component claims are surfaced, not swallowed')

  // A component whose source path no longer exists is indistinguishable from an untouched
  // one unless it is called out — that silence is how the manifest rots unnoticed.
  const withDead = client.attribute(ir, absolute, '/repo', { docs: ['notes'] })
  assert.deepEqual(withDead.components.find((c) => c.id === 'docs').dead, ['notes'], 'dead sources reach the row')
  assert.deepEqual(withDead.components.find((c) => c.id === 'suite').dead, [], 'live components carry no dead paths')
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

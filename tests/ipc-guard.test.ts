import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  assertTrustedSender,
  encodeSessionCwdKey,
  IMAGE_EXT_SET,
  isAllowedExternalUrl,
  isAppUrl,
  isLocalDevHost,
  isPathInside,
  MAX_IMAGE_BYTES,
  mimeForImageExt
} from '../electron/main/ipc-guard'

const DEV = 'http://localhost:5173'

function sender(url: string | null) {
  return { senderFrame: url === null ? null : { url } }
}

// ── IPC sender trust ────────────────────────────────────────────────

test('packaged builds accept only file:// senders', () => {
  assert.doesNotThrow(() => assertTrustedSender(sender('file:///C:/app/out/index.html'), undefined))
  for (const bad of [
    'https://evil.example/page',
    'http://localhost:5173/',
    'data:text/html,<script>x</script>',
    'about:blank',
    ''
  ]) {
    assert.throws(() => assertTrustedSender(sender(bad), undefined), /untrusted sender/)
  }
})

test('dev builds accept only loopback http senders', () => {
  for (const ok of ['http://localhost:5173/', 'http://127.0.0.1:5199/x', 'https://localhost/y']) {
    assert.doesNotThrow(() => assertTrustedSender(sender(ok), DEV))
  }
  for (const bad of [
    'http://evil.example/',
    'http://localhost.evil.example/',
    'http://127.0.0.1.evil.example/',
    'file:///C:/app/index.html',
    'not a url'
  ]) {
    assert.throws(() => assertTrustedSender(sender(bad), DEV), /untrusted sender/)
  }
})

test('a missing sender frame is rejected in both modes', () => {
  assert.throws(() => assertTrustedSender(sender(null), undefined), /untrusted sender/)
  assert.throws(() => assertTrustedSender(sender(null), DEV), /untrusted sender/)
  assert.throws(() => assertTrustedSender({}, undefined), /untrusted sender/)
})

test('the rejection message never echoes an unbounded sender url back', () => {
  try {
    assertTrustedSender(sender('https://evil.example/x'), undefined)
    assert.fail('should have thrown')
  } catch (err) {
    assert.match((err as Error).message, /^Rejected IPC from untrusted sender: /)
  }
})

// ── Loopback host matching ──────────────────────────────────────────

test('only exact loopback hostnames count as local', () => {
  for (const ok of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(isLocalDevHost(ok), true, ok)
  }
  for (const bad of [
    'localhost.evil.example',
    'evil-localhost',
    '127.0.0.1.evil.example',
    '0.0.0.0',
    '192.168.1.5',
    ''
  ]) {
    assert.equal(isLocalDevHost(bad), false, bad)
  }
})

// ── Navigation lock ─────────────────────────────────────────────────

test('isAppUrl only allows file:// when packaged', () => {
  assert.equal(isAppUrl('file:///C:/app/index.html'), true)
  assert.equal(isAppUrl('http://localhost:5173/'), false)
  assert.equal(isAppUrl('https://grok.com'), false)
  assert.equal(isAppUrl('garbage'), false)
})

test('isAppUrl allows the loopback dev server only in dev', () => {
  assert.equal(isAppUrl('http://localhost:5173/', DEV), true)
  assert.equal(isAppUrl('http://127.0.0.1:5173/', DEV), true)
  assert.equal(isAppUrl('http://evil.example/', DEV), false)
  assert.equal(isAppUrl('file:///C:/app/index.html', DEV), false)
})

// ── openExternal allow-list ─────────────────────────────────────────

test('only http, https and mailto may be opened externally', () => {
  for (const ok of ['https://x.ai', 'http://example.com', 'mailto:a@b.com']) {
    assert.equal(isAllowedExternalUrl(ok), true, ok)
  }
  for (const bad of [
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:msgbox',
    'ms-msdt:/id',
    'smb://server/share',
    '',
    'not a url'
  ]) {
    assert.equal(isAllowedExternalUrl(bad), false, bad)
  }
})

// ── Path containment (the fs jail's lexical half) ───────────────────

test('a path inside the root is accepted, the root itself included', () => {
  const root = path.resolve('/data/project')
  assert.equal(isPathInside(root, root), true)
  assert.equal(isPathInside(root, path.join(root, 'src', 'index.ts')), true)
})

test('a sibling directory sharing a name prefix is NOT inside', () => {
  // Without the trailing separator, "/data/project-secrets" would pass.
  assert.equal(isPathInside(path.resolve('/data/project'), path.resolve('/data/project-secrets')), false)
  assert.equal(isPathInside(path.resolve('/data/priv'), path.resolve('/data/private')), false)
})

test('traversal out of the root is rejected', () => {
  const root = path.resolve('/data/project')
  assert.equal(isPathInside(root, path.join(root, '..', 'other', 'file.txt')), false)
  assert.equal(isPathInside(root, path.join(root, '..', '..', 'etc', 'passwd')), false)
})

test('a parent of the root is not inside it', () => {
  assert.equal(isPathInside(path.resolve('/data/project'), path.resolve('/data')), false)
})

// ── Image IPC caps ──────────────────────────────────────────────────

test('only known image extensions are allowed', () => {
  for (const ok of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']) {
    assert.equal(IMAGE_EXT_SET.has(ok), true, ok)
  }
  for (const bad of ['.exe', '.html', '.js', '.ps1', '.lnk', '.svgz', '']) {
    assert.equal(IMAGE_EXT_SET.has(bad), false, bad)
  }
})

test('mime lookup is case-insensitive and falls back to octet-stream', () => {
  assert.equal(mimeForImageExt('.PNG'), 'image/png')
  assert.equal(mimeForImageExt('.jpeg'), 'image/jpeg')
  assert.equal(mimeForImageExt('.svg'), 'image/svg+xml')
  assert.equal(mimeForImageExt('.exe'), 'application/octet-stream')
})

test('the image size cap stays at 20 MB', () => {
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024)
})

// ── Session folder key ──────────────────────────────────────────────

test('session cwd keys normalize slashes before encoding', () => {
  assert.equal(encodeSessionCwdKey('C:\\work\\app'), encodeSessionCwdKey('C:/work/app'))
  assert.equal(encodeSessionCwdKey('C:/work/app'), 'C%3A%2Fwork%2Fapp')
  assert.equal(encodeSessionCwdKey('C:/work/app/'), 'C%3A%2Fwork%2Fapp', 'trailing slash ignored')
})

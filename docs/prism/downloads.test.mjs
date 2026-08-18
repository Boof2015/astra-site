import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyReleaseAssets,
  detectPlatform,
  newestPublishedRelease,
  preferredAsset,
} from './downloads.js'

const asset = (name) => ({
  name,
  browser_download_url: `https://example.test/${encodeURIComponent(name)}`,
})

test('detectPlatform recognizes the three supported desktop platforms', () => {
  assert.equal(detectPlatform('Win32', ''), 'windows')
  assert.equal(detectPlatform('MacIntel', ''), 'mac')
  assert.equal(detectPlatform('Linux x86_64', ''), 'linux')
  assert.equal(detectPlatform('iPhone', 'Mobile'), 'other')
})

test('newestPublishedRelease includes prereleases but excludes drafts', () => {
  const selected = newestPublishedRelease([
    { tag_name: 'v0.4.0-draft', draft: true, published_at: '2026-08-20', assets: [] },
    { tag_name: 'v0.3.0-beta', draft: false, prerelease: true, published_at: '2026-08-18', assets: [] },
    { tag_name: 'v0.2.0-beta', draft: false, prerelease: true, published_at: '2026-05-01', assets: [] },
  ])

  assert.equal(selected.tag_name, 'v0.3.0-beta')
})

test('release assets are grouped and preferred in the intended order', () => {
  const groups = classifyReleaseAssets([
    asset('Prism-0.3.0-beta-portable.exe'),
    asset('Prism-Setup-0.3.0-beta.exe'),
    asset('Prism-0.3.0-beta-arm64-mac.zip'),
    asset('Prism-0.3.0-beta-arm64.pkg'),
    asset('Prism-0.3.0-beta.AppImage'),
    asset('prism_0.3.0_amd64.deb'),
    asset('prism-0.3.0.x86_64.rpm'),
    asset('prism-0.3.0-linux.tar.gz'),
    asset('latest-mac.yml'),
  ])

  assert.equal(preferredAsset(groups, 'windows').kind, 'installer')
  assert.equal(preferredAsset(groups, 'mac').kind, 'pkg')
  assert.equal(preferredAsset(groups, 'linux').kind, 'appimage')
  assert.deepEqual(groups.linux.map((entry) => entry.kind), ['appimage', 'deb', 'rpm', 'tarball'])
})

test('missing formats fail softly', () => {
  const groups = classifyReleaseAssets([])
  assert.equal(preferredAsset(groups, 'windows'), null)
  assert.equal(newestPublishedRelease(null), null)
})

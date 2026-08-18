export const RELEASES_URL = 'https://github.com/Boof2015/prism/releases'
export const RELEASES_API = 'https://api.github.com/repos/Boof2015/prism/releases?per_page=20'

export function detectPlatform(platform = '', userAgent = '') {
  const value = `${platform} ${userAgent}`
  if (/windows|win32|win64/i.test(value)) return 'windows'
  if (/macintosh|mac os|macintel|darwin/i.test(value)) return 'mac'
  if (/linux|x11/i.test(value)) return 'linux'
  return 'other'
}

export function newestPublishedRelease(releases) {
  if (!Array.isArray(releases)) return null

  return releases
    .filter((release) => release && !release.draft && Array.isArray(release.assets))
    .sort((a, b) => {
      const aDate = Date.parse(a.published_at || a.created_at || 0) || 0
      const bDate = Date.parse(b.published_at || b.created_at || 0) || 0
      return bDate - aDate
    })[0] || null
}

export function classifyReleaseAssets(assets) {
  const groups = {
    windows: [],
    mac: [],
    linux: [],
  }

  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || !asset.name || !asset.browser_download_url) continue
    const name = asset.name
    const lower = name.toLowerCase()
    const entry = { name, url: asset.browser_download_url, kind: 'other' }

    if (lower.endsWith('.exe')) {
      entry.kind = /portable/i.test(name) ? 'portable' : 'installer'
      groups.windows.push(entry)
      continue
    }

    if (lower.endsWith('.pkg')) {
      entry.kind = 'pkg'
      groups.mac.push(entry)
      continue
    }

    if (lower.endsWith('.zip') && !lower.endsWith('.blockmap.zip')) {
      entry.kind = 'zip'
      groups.mac.push(entry)
      continue
    }

    if (lower.endsWith('.appimage')) {
      entry.kind = 'appimage'
      groups.linux.push(entry)
      continue
    }

    if (lower.endsWith('.deb')) {
      entry.kind = 'deb'
      groups.linux.push(entry)
      continue
    }

    if (lower.endsWith('.rpm')) {
      entry.kind = 'rpm'
      groups.linux.push(entry)
      continue
    }

    if (lower.endsWith('.tar.gz')) {
      entry.kind = 'tarball'
      groups.linux.push(entry)
    }
  }

  return groups
}

export function preferredAsset(groups, platform) {
  const preference = {
    windows: ['installer', 'portable'],
    mac: ['pkg', 'zip'],
    linux: ['appimage', 'deb', 'rpm', 'tarball'],
  }[platform]

  if (!preference || !groups || !Array.isArray(groups[platform])) return null
  for (const kind of preference) {
    const match = groups[platform].find((asset) => asset.kind === kind)
    if (match) return match
  }
  return null
}

export function formatLabel(asset) {
  const labels = {
    installer: 'Installer (.exe)',
    portable: 'Portable (.exe)',
    pkg: 'Installer (.pkg)',
    zip: 'Archive (.zip)',
    appimage: 'AppImage',
    deb: 'Debian (.deb)',
    rpm: 'RPM package',
    tarball: 'Tarball (.tar.gz)',
  }
  return labels[asset.kind] || asset.name
}

import {
  RELEASES_API,
  RELEASES_URL,
  classifyReleaseAssets,
  detectPlatform,
  formatLabel,
  newestPublishedRelease,
  preferredAsset,
} from './downloads.js'

function initMobileNavigation() {
  const button = document.getElementById('nav-menu-button')
  const links = document.getElementById('nav-links')
  if (!button || !links) return

  function closeMenu() {
    links.classList.remove('is-open')
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-label', 'Open menu')
  }

  button.addEventListener('click', () => {
    const open = !links.classList.contains('is-open')
    links.classList.toggle('is-open', open)
    button.setAttribute('aria-expanded', String(open))
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
  })

  links.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu()
  })
}

function initReveal() {
  const items = document.querySelectorAll('.reveal')
  if (!items.length) return
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    })
  }, { threshold: 0.08 })

  items.forEach((item) => observer.observe(item))
}

function initVideos() {
  const videos = document.querySelectorAll('video')
  if (!videos.length) return
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (reducedMotion) {
    videos.forEach((video) => {
      video.removeAttribute('autoplay')
      video.pause()
    })
    return
  }

  if (!('IntersectionObserver' in window)) return
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = entry.target
      if (entry.isIntersecting && !document.hidden) {
        const promise = video.play()
        if (promise) promise.catch(() => {})
      } else {
        video.pause()
      }
    })
  }, { threshold: 0.12 })

  videos.forEach((video) => observer.observe(video))
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) videos.forEach((video) => video.pause())
  })
}

function initDownloads() {
  const platformNames = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }
  const platform = detectPlatform(navigator.userAgentData?.platform || navigator.platform || '', navigator.userAgent || '')
  const primaryLink = document.getElementById('hero-download-link')
  const primaryLabel = document.getElementById('hero-download-label')
  const navLink = document.getElementById('nav-download-link')
  const menuButton = document.getElementById('download-chevron')
  const menu = document.getElementById('download-menu')
  const split = document.getElementById('download-split')

  function closeDownloadMenu() {
    if (!menu || !menuButton) return
    menu.hidden = true
    menuButton.setAttribute('aria-expanded', 'false')
  }

  function addMenuGroup(name, assets) {
    if (!menu || !assets.length) return
    const heading = document.createElement('div')
    heading.className = 'download-menu-label'
    heading.textContent = name
    menu.appendChild(heading)

    assets.forEach((asset) => {
      const link = document.createElement('a')
      link.href = asset.url
      const label = document.createElement('span')
      const marker = document.createElement('span')
      label.textContent = formatLabel(asset)
      marker.textContent = '↓'
      link.append(label, marker)
      menu.appendChild(link)
    })
  }

  if (menuButton && menu) {
    menuButton.addEventListener('click', () => {
      const open = menu.hidden
      menu.hidden = !open
      menuButton.setAttribute('aria-expanded', String(open))
      if (open) menu.querySelector('a')?.focus()
    })
    document.addEventListener('click', (event) => {
      if (split && !split.contains(event.target)) closeDownloadMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      const wasOpen = !menu.hidden
      closeDownloadMenu()
      if (wasOpen) menuButton.focus()
    })
  }

  if (primaryLabel && platformNames[platform]) primaryLabel.textContent = `Download for ${platformNames[platform]}`

  fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => {
      if (!response.ok) throw new Error('Release lookup failed')
      return response.json()
    })
    .then((releases) => {
      const release = newestPublishedRelease(releases)
      if (!release) return
      const groups = classifyReleaseAssets(release.assets)
      const primary = preferredAsset(groups, platform)

      if (primary && primaryLink) primaryLink.href = primary.url
      if (primary && navLink) navLink.href = primary.url

      for (const name of ['windows', 'mac', 'linux']) {
        const best = preferredAsset(groups, name)
        const card = document.getElementById(`download-${name}`)
        if (best && card) card.href = best.url
      }

      if (!menu) return
      menu.replaceChildren()
      addMenuGroup('Windows', groups.windows)
      addMenuGroup('macOS', groups.mac)
      addMenuGroup('Linux', groups.linux)

      const releasesLink = document.createElement('a')
      releasesLink.href = release.html_url || RELEASES_URL
      releasesLink.target = '_blank'
      releasesLink.rel = 'noopener'
      const label = document.createElement('span')
      const marker = document.createElement('span')
      label.textContent = 'All release assets'
      marker.textContent = '↗'
      releasesLink.append(label, marker)
      menu.appendChild(releasesLink)
    })
    .catch(() => {
      // Initial Releases links remain functional when the API is unavailable.
    })
}

initMobileNavigation()
initReveal()
initVideos()
initDownloads()
window.__prismAppReady = true

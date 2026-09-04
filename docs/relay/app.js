const THEME_KEY = 'astra-relay-theme';

export function resolveTheme(savedTheme, systemPrefersDark = false) {
  if (savedTheme === 'paper' || savedTheme === 'ink') return savedTheme;
  return systemPrefersDark ? 'ink' : 'paper';
}

export function normalizeSearchValue(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function rotationMatchesQuery(record, value) {
  const query = normalizeSearchValue(value);
  if (!query) return true;
  if (/^\d+$/.test(query) && Number(query) === Number(record.number)) return true;
  return normalizeSearchValue(record.search).includes(query);
}

export function relayRoute(value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value), 'https://astramusic.dev');
  } catch {
    return null;
  }
  const pathname = url.pathname
    .replace(/\/index\.html$/, '/')
    .replace(/\/{2,}/g, '/');
  if (pathname === '/relay' || pathname === '/relay/') return { kind: 'index', number: null };
  const detail = pathname.match(/^\/relay\/(\d+)\/?$/);
  if (!detail) return null;
  return { kind: 'detail', number: Number(detail[1]) };
}

function setTheme(theme, { persist = false } = {}) {
  const resolved = theme === 'ink' ? 'ink' : 'paper';
  document.documentElement.dataset.theme = resolved;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, resolved);
    } catch {
      // The selected theme still applies for the current page.
    }
  }
  const toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    const next = resolved === 'paper' ? 'ink' : 'paper';
    toggle.setAttribute('aria-label', `Switch to ${next} theme`);
    toggle.setAttribute('aria-pressed', String(resolved === 'ink'));
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', resolved === 'ink' ? '#0f0f0f' : '#f0f0f0');
}

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function bindTheme() {
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const applyPreferredTheme = () => {
    setTheme(resolveTheme(storedTheme(), systemTheme.matches));
  };
  applyPreferredTheme();
  document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'ink' ? 'paper' : 'ink', { persist: true });
  });
  systemTheme.addEventListener?.('change', () => {
    if (storedTheme() !== 'paper' && storedTheme() !== 'ink') applyPreferredTheme();
  });
  return applyPreferredTheme;
}

function bindArchiveSearch() {
  const input = document.querySelector('[data-archive-search]');
  const records = [...document.querySelectorAll('.archive-record')];
  const status = document.querySelector('[data-archive-status]');
  const empty = document.querySelector('[data-archive-empty]');
  if (!input || !status || !empty || records.length === 0) return;

  const update = () => {
    let visible = 0;
    for (const record of records) {
      const matches = rotationMatchesQuery({
        number: record.dataset.rotation,
        search: record.dataset.search,
      }, input.value);
      record.hidden = !matches;
      if (matches) visible += 1;
    }
    status.textContent = `${visible} ${visible === 1 ? 'ROTATION' : 'ROTATIONS'}`;
    empty.hidden = visible !== 0;
  };
  input.addEventListener('input', update);
  update();
}

if (typeof document !== 'undefined') {
  const applyPreferredTheme = bindTheme();
  bindArchiveSearch();
  window.addEventListener('pageshow', applyPreferredTheme);
}

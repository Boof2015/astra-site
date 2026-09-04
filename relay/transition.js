(() => {
  const DEPARTURE_KEY = 'astra-relay-departure';
  const MAX_DEPARTURE_AGE = 8_000;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let storedForCurrentNavigation = false;
  let arrivalRunning = false;
  let departureRunning = false;
  let coldOpenPending = false;
  let nativeBridgeFinished = Promise.resolve();
  let activeDepartureAnimations = [];
  let activeDepartureTemporary = [];

  function route(value) {
    let url;
    try {
      url = value instanceof URL ? value : new URL(String(value), window.location.href);
    } catch {
      return null;
    }
    const pathname = url.pathname
      .replace(/\/index\.html$/, '/')
      .replace(/\/{2,}/g, '/');
    if (pathname === '/relay' || pathname === '/relay/') {
      return { kind: 'index', number: null, url: url.href };
    }
    const detail = pathname.match(/^\/relay\/(\d+)\/?$/);
    if (!detail) return null;
    return { kind: 'detail', number: Number(detail[1]), url: url.href };
  }

  function sameRoute(left, right) {
    return left?.kind === right?.kind && left?.number === right?.number;
  }

  function transitionContext(fromValue, toValue) {
    const from = route(fromValue);
    const to = route(toValue);
    if (!from || !to || sameRoute(from, to)) return null;
    return { from, to };
  }

  function isAdjacentDetailNavigation(context) {
    return context?.from.kind === 'detail' && context.to.kind === 'detail';
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.top < window.innerHeight
      && rect.right > 0
      && rect.left < window.innerWidth;
  }

  function artworkForRotation(number, root = document) {
    return root.querySelector(`[data-transition-art][data-rotation="${number}"]`);
  }

  function archiveArtworkForRotation(number) {
    return document.querySelector(`.archive-record [data-transition-art][data-rotation="${number}"]`);
  }

  function sourceArtworkFor(context) {
    if (context?.from.kind === 'index' && context.to.kind === 'detail') {
      return artworkForRotation(context.to.number);
    }
    return document.querySelector('.featured [data-transition-art]');
  }

  function destinationArtworkFor(context) {
    if (context.to.kind === 'detail') {
      return document.querySelector('.featured [data-transition-art]');
    }
    if (window.location.hash === '#archive') {
      return archiveArtworkForRotation(context.from?.number);
    }
    return artworkForRotation(context.from?.number);
  }

  function artworkSnapshot(element) {
    if (!(element instanceof HTMLImageElement) || !isVisible(element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      src: element.currentSrc || element.src,
      rotation: Number(element.dataset.rotation),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
  }

  function writeDeparture(destinationValue = null) {
    const context = destinationValue
      ? transitionContext(window.location.href, destinationValue)
      : null;
    const from = route(window.location.href);
    if (!from) return;
    const departure = {
      from: from.url,
      to: context?.to.url || null,
      createdAt: Date.now(),
      artwork: artworkSnapshot(sourceArtworkFor(context)),
    };
    try {
      sessionStorage.setItem(DEPARTURE_KEY, JSON.stringify(departure));
      storedForCurrentNavigation = true;
    } catch {
      // The site still performs an ordinary navigation when storage is unavailable.
    }
    return departure;
  }

  function readDeparture() {
    try {
      const departure = JSON.parse(sessionStorage.getItem(DEPARTURE_KEY) || 'null');
      if (!departure || Date.now() - departure.createdAt > MAX_DEPARTURE_AGE) return null;
      const context = transitionContext(departure.from, window.location.href);
      if (!context) return null;
      if (departure.to && !sameRoute(route(departure.to), context.to)) return null;
      return { departure, context };
    } catch {
      return null;
    }
  }

  function clearDeparture() {
    try {
      sessionStorage.removeItem(DEPARTURE_KEY);
    } catch {
      // No cleanup is required when storage is unavailable.
    }
  }

  function adjustedSourceRect(snapshot) {
    if (!snapshot?.rect || !snapshot.viewport?.width || !snapshot.viewport?.height) return null;
    const scaleX = window.innerWidth / snapshot.viewport.width;
    const scaleY = window.innerHeight / snapshot.viewport.height;
    return {
      left: snapshot.rect.left * scaleX,
      top: snapshot.rect.top * scaleY,
      width: snapshot.rect.width * scaleX,
      height: snapshot.rect.height * scaleY,
    };
  }

  function pausedAnimation(element, keyframes, options, animations) {
    if (!(element instanceof HTMLElement)) return null;
    element.style.visibility = 'visible';
    const animation = element.animate(keyframes, { ...options, fill: 'both' });
    animation.pause();
    animations.push(animation);
    return animation;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function restoreDepartureVisuals() {
    activeDepartureAnimations.forEach((animation) => animation.cancel());
    activeDepartureTemporary.forEach((element) => element.remove());
    activeDepartureAnimations = [];
    activeDepartureTemporary = [];
  }

  async function settleIncomingLayout() {
    await document.fonts?.ready;
    await nextFrame();
    await nextFrame();
    if (window.location.hash) {
      const anchor = document.getElementById(window.location.hash.slice(1));
      const root = document.documentElement;
      const previousScrollBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      anchor?.scrollIntoView({ block: 'start' });
      await nextFrame();
      await nextFrame();
      root.style.scrollBehavior = previousScrollBehavior;
    }
  }

  function createScan(target, delay, duration, animations, temporary) {
    if (!(target instanceof HTMLElement) || !isVisible(target)) return;
    const rect = target.getBoundingClientRect();
    const scan = document.createElement('span');
    scan.className = 'relay-live-scan';
    scan.setAttribute('aria-hidden', 'true');
    scan.style.left = `${rect.left}px`;
    scan.style.top = `${rect.top}px`;
    scan.style.width = `${rect.width}px`;
    scan.style.height = `${rect.height}px`;

    const sweep = document.createElement('span');
    sweep.className = 'relay-live-scan-sweep';
    scan.append(sweep);
    document.body.append(scan);
    temporary.push(scan);
    pausedAnimation(sweep, [
      { transform: 'translateX(-125%)' },
      { transform: 'translateX(120%)' },
    ], {
      duration,
      delay,
      easing: 'cubic-bezier(0.82, 0, 0.14, 1)',
    }, animations);
  }

  function prepareScanContent(target, delay, animations, temporary, styled, timing = {}) {
    if (!(target instanceof HTMLElement) || !isVisible(target)) return;
    const sweepDuration = timing.sweepDuration ?? 350;
    const revealDelay = timing.revealDelay ?? 72;
    const revealDuration = timing.revealDuration ?? 218;
    const travel = timing.travel ?? 12;
    styled.push(target);
    pausedAnimation(target, [
      { clipPath: 'inset(0 100% 0 0)', transform: `translateX(-${travel}px)` },
      { clipPath: 'inset(0 0 0 0)', transform: 'translateX(0)' },
    ], {
      duration: revealDuration,
      delay: delay + revealDelay,
      easing: 'cubic-bezier(0.62, 0, 0.2, 1)',
    }, animations);
    createScan(target, delay, sweepDuration, animations, temporary);
  }

  function prepareFeaturedArrival(animations, temporary, styled) {
    const title = document.querySelector('.featured [data-signal-title]');
    if (title instanceof HTMLElement && isVisible(title)) {
      prepareScanContent(title, 155, animations, temporary, styled, {
        sweepDuration: 410,
        revealDelay: 82,
        revealDuration: 240,
        travel: 18,
      });
    }

    const metadata = [...document.querySelectorAll('.featured [data-signal-meta]')].slice(0, 4);
    metadata.forEach((element, index) => {
      prepareScanContent(element, 300 + (index * 52), animations, temporary, styled);
    });

    const action = document.querySelector('.featured [data-signal-action="action"]');
    const helper = document.querySelector('.featured [data-signal-action="helper"]');
    if (action instanceof HTMLElement && isVisible(action)) {
      styled.push(action);
      pausedAnimation(action, [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], {
        duration: 220,
        delay: 650,
        easing: 'cubic-bezier(0.2, 0.72, 0.18, 1)',
      }, animations);
    }
    if (helper instanceof HTMLElement && isVisible(helper)) {
      styled.push(helper);
      pausedAnimation(helper, [
        { opacity: 0, clipPath: 'inset(0 100% 0 0)' },
        { opacity: 1, clipPath: 'inset(0 0 0 0)' },
      ], {
        duration: 160,
        delay: 720,
        easing: 'steps(6, end)',
      }, animations);
    }
  }

  function prepareArchiveArrival(context, animations, temporary, styled) {
    const artwork = destinationArtworkFor(context);
    const destination = artwork?.closest('.archive-record')?.querySelector('[data-signal-source]');
    if (destination instanceof HTMLElement && isVisible(destination)) {
      const rows = [...destination.querySelectorAll('.archive-topline, strong, em')];
      (rows.length > 0 ? rows : [destination]).forEach((element, index) => {
        prepareScanContent(element, 180 + (index * 52), animations, temporary, styled);
      });
      return;
    }

    const heading = document.querySelector('.archive-heading h2');
    const search = document.querySelector('.archive-search');
    prepareScanContent(heading, 180, animations, temporary, styled);
    prepareScanContent(search, 232, animations, temporary, styled);
  }

  function prepareTextArrival(context, animations, temporary, styled, { initial = false } = {}) {
    const enteringFeatured = context.to.kind === 'detail'
      || (initial && context.to.kind === 'index' && window.location.hash !== '#archive');
    if (enteringFeatured) {
      prepareFeaturedArrival(animations, temporary, styled);
      return;
    }
    prepareArchiveArrival(context, animations, temporary, styled);
  }

  function createArtworkFlight(snapshot, destination, animations, temporary, styled) {
    if (!(destination instanceof HTMLImageElement) || !isVisible(destination)) return null;
    const destinationRect = destination.getBoundingClientRect();
    const sourceRect = adjustedSourceRect(snapshot);

    if (!sourceRect || sourceRect.width <= 0 || sourceRect.height <= 0) {
      styled.push(destination);
      return pausedAnimation(destination, [
        { opacity: 0, filter: 'contrast(1.55) saturate(0.28)', transform: 'scale(1.014)' },
        { opacity: 0.45, filter: 'contrast(1.35) saturate(0.48)', offset: 0.34 },
        { opacity: 1, filter: 'contrast(1) saturate(1)', transform: 'scale(1)' },
      ], {
        duration: 520,
        delay: 60,
        easing: 'cubic-bezier(0.18, 0.72, 0.2, 1)',
      }, animations);
    }

    destination.style.visibility = 'hidden';
    styled.push(destination);
    const destinationFrame = destination.closest('.artwork-frame');
    if (destinationFrame instanceof HTMLElement) {
      destinationFrame.classList.add('relay-flight-destination');
      styled.push(destinationFrame);
    }
    const flight = document.createElement('span');
    flight.className = 'relay-live-art-flight';
    flight.setAttribute('aria-hidden', 'true');
    flight.style.left = `${sourceRect.left}px`;
    flight.style.top = `${sourceRect.top}px`;
    flight.style.width = `${sourceRect.width}px`;
    flight.style.height = `${sourceRect.height}px`;

    const sourceImage = document.createElement('img');
    sourceImage.src = snapshot.src || destination.currentSrc || destination.src;
    sourceImage.alt = '';
    flight.append(sourceImage);

    const destinationUrl = destination.currentSrc || destination.src;
    if (destinationUrl && destinationUrl !== sourceImage.src) {
      const destinationImage = document.createElement('img');
      destinationImage.className = 'relay-live-art-destination';
      destinationImage.src = destinationUrl;
      destinationImage.alt = '';
      flight.append(destinationImage);
      pausedAnimation(sourceImage, [
        { opacity: 1, filter: 'contrast(1) saturate(1)', offset: 0 },
        { opacity: 1, filter: 'contrast(1.55) saturate(0.3)', offset: 0.34 },
        { opacity: 0, filter: 'contrast(1.55) saturate(0.3)', offset: 0.43 },
        { opacity: 0, offset: 1 },
      ], { duration: 680, easing: 'linear' }, animations);
      pausedAnimation(destinationImage, [
        { opacity: 0, filter: 'contrast(1.6) saturate(0.25)', offset: 0 },
        { opacity: 0, filter: 'contrast(1.6) saturate(0.25)', offset: 0.36 },
        { opacity: 0.55, filter: 'contrast(1.35) saturate(0.55)', offset: 0.44 },
        { opacity: 1, filter: 'contrast(1) saturate(1)', offset: 0.62 },
        { opacity: 1, offset: 1 },
      ], { duration: 680, easing: 'linear' }, animations);
    } else {
      pausedAnimation(sourceImage, [
        { filter: 'contrast(1) saturate(1)', offset: 0 },
        { filter: 'contrast(1.48) saturate(0.38)', offset: 0.39 },
        { filter: 'contrast(1) saturate(1)', offset: 0.58 },
        { filter: 'contrast(1) saturate(1)', offset: 1 },
      ], { duration: 680, easing: 'linear' }, animations);
    }

    document.body.append(flight);
    temporary.push(flight);
    pausedAnimation(flight, [
      { transform: 'translate(0, 0) scale(1, 1)' },
      {
        transform: `translate(${destinationRect.left - sourceRect.left}px, ${destinationRect.top - sourceRect.top}px) scale(${destinationRect.width / sourceRect.width}, ${destinationRect.height / sourceRect.height})`,
      },
    ], {
      duration: 680,
      easing: 'cubic-bezier(0.2, 0.78, 0.18, 1)',
    }, animations);
    return flight;
  }

  function createDepartureScan(target, delay, duration, animations, temporary) {
    if (!(target instanceof HTMLElement) || !isVisible(target)) return;
    const rect = target.getBoundingClientRect();
    const scan = document.createElement('span');
    scan.className = 'relay-live-scan';
    scan.setAttribute('aria-hidden', 'true');
    scan.style.left = `${rect.left}px`;
    scan.style.top = `${rect.top}px`;
    scan.style.width = `${rect.width}px`;
    scan.style.height = `${rect.height}px`;

    const sweep = document.createElement('span');
    sweep.className = 'relay-live-scan-sweep';
    scan.append(sweep);
    document.body.append(scan);
    temporary.push(scan);

    animations.push(sweep.animate([
      { transform: 'translateX(-125%)' },
      { transform: 'translateX(120%)' },
    ], {
      duration,
      delay,
      easing: 'cubic-bezier(0.82, 0, 0.14, 1)',
      fill: 'both',
    }));
    animations.push(target.animate([
      { clipPath: 'inset(0 0 0 0)', transform: 'translateX(0)' },
      { clipPath: 'inset(0 0 0 100%)', transform: 'translateX(12px)' },
    ], {
      duration: Math.max(160, duration - 82),
      delay: delay + 58,
      easing: 'cubic-bezier(0.62, 0, 0.2, 1)',
      fill: 'both',
    }));
  }

  async function runDeparture(context) {
    if (reducedMotion.matches || typeof Element.prototype.animate !== 'function') return;
    restoreDepartureVisuals();
    const animations = [];
    const temporary = [];
    activeDepartureAnimations = animations;
    activeDepartureTemporary = temporary;
    const artwork = sourceArtworkFor(context);
    const source = artwork?.closest('.archive-record, .featured');

    if (source?.classList.contains('archive-record')) {
      const rows = [...source.querySelectorAll('.archive-topline, strong, em')];
      rows.forEach((element, index) => {
        createDepartureScan(element, index * 24, 270, animations, temporary);
      });
    } else if (source instanceof HTMLElement) {
      const metadata = [...source.querySelectorAll('[data-signal-meta]')].reverse();
      metadata.forEach((element, index) => {
        createDepartureScan(element, index * 24, 270, animations, temporary);
      });
      const title = source.querySelector('[data-signal-title]');
      createDepartureScan(title, 48, 310, animations, temporary);

      for (const element of source.querySelectorAll('[data-signal-action]')) {
        if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
        animations.push(element.animate([
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-6px)' },
        ], {
          duration: 150,
          easing: 'cubic-bezier(0.62, 0, 0.2, 1)',
          fill: 'both',
        }));
      }
    }

    if (animations.length === 0) {
      await nextFrame();
      return;
    }
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    temporary.forEach((element) => element.remove());
  }

  async function runArrival() {
    if (arrivalRunning) return;
    const payload = readDeparture();
    const currentRoute = route(window.location.href);
    const initial = !payload && coldOpenPending;
    if ((!payload && !initial) || !currentRoute || reducedMotion.matches || typeof Element.prototype.animate !== 'function') {
      document.documentElement.classList.remove('relay-arrival-pending');
      clearDeparture();
      return;
    }

    arrivalRunning = true;
    clearDeparture();
    const animations = [];
    const temporary = [];
    const styled = [];
    try {
      await settleIncomingLayout();
      const context = payload?.context ?? { from: null, to: currentRoute };
      const destination = payload
        ? destinationArtworkFor(context)
        : document.querySelector('.featured [data-transition-art]');
      createArtworkFlight(payload?.departure.artwork ?? null, destination, animations, temporary, styled);
      prepareTextArrival(context, animations, temporary, styled, { initial });

      if (animations.length === 0) {
        document.documentElement.classList.remove('relay-arrival-pending');
        return;
      }

      await nativeBridgeFinished;
      await new Promise((resolve) => requestAnimationFrame(() => {
        document.documentElement.classList.remove('relay-arrival-pending');
        animations.forEach((animation) => animation.play());
        resolve();
      }));
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    } finally {
      animations.forEach((animation) => animation.cancel());
      styled.forEach((element) => {
        element.style.removeProperty('visibility');
        element.classList.remove('relay-flight-destination');
      });
      temporary.forEach((element) => {
        element.remove();
      });
      document.documentElement.classList.remove('relay-arrival-pending');
      arrivalRunning = false;
      coldOpenPending = false;
      nativeBridgeFinished = Promise.resolve();
    }
  }

  const navigationType = performance.getEntriesByType('navigation')[0]?.type;
  const initialDeparture = readDeparture();
  coldOpenPending = !initialDeparture && navigationType !== 'back_forward';
  if (!reducedMotion.matches && (initialDeparture || coldOpenPending)) {
    document.documentElement.classList.add('relay-arrival-pending');
  }

  document.addEventListener('click', async (event) => {
    const target = event.target;
    const link = target instanceof Element ? target.closest('a[href]') : null;
    if (
      !link
      || event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || link.target
      || link.hasAttribute('download')
    ) return;
    const destination = new URL(link.href, window.location.href);
    const context = destination.origin === window.location.origin
      ? transitionContext(window.location.href, destination)
      : null;
    if (!context) return;
    writeDeparture(destination.href);
    const shouldAnimateDeparture = isAdjacentDetailNavigation(context)
      && link.closest('.rotation-navigation');
    if (!shouldAnimateDeparture || reducedMotion.matches || typeof Element.prototype.animate !== 'function') return;

    event.preventDefault();
    if (departureRunning) return;
    departureRunning = true;
    document.documentElement.classList.add('relay-departing');
    try {
      await runDeparture(context);
    } finally {
      window.location.assign(destination.href);
    }
  }, true);

  window.addEventListener('pageswap', (event) => {
    const destination = event.activation?.entry?.url;
    const context = destination ? transitionContext(window.location.href, destination) : null;
    if (event.viewTransition && (reducedMotion.matches || !isAdjacentDetailNavigation(context))) {
      event.viewTransition.skipTransition();
    }
    if (!storedForCurrentNavigation && context) {
      writeDeparture(destination);
    }
  });

  window.addEventListener('pagereveal', (event) => {
    if (!event.viewTransition) return;
    const context = readDeparture()?.context;
    if (reducedMotion.matches || !isAdjacentDetailNavigation(context)) {
      event.viewTransition.skipTransition();
      return;
    }
    nativeBridgeFinished = event.viewTransition.finished.catch(() => undefined);
  });

  window.addEventListener('pagehide', () => {
    if (!storedForCurrentNavigation) writeDeparture();
    storedForCurrentNavigation = false;
  });

  window.addEventListener('pageshow', () => {
    restoreDepartureVisuals();
    document.documentElement.classList.remove('relay-departing');
    departureRunning = false;
    void runArrival();
  });
})();

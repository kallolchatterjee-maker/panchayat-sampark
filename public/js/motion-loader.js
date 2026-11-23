// Boots the hero entrance immediately, then lazy-imports the card text module
// as the first story card approaches. ScrollTrigger drives the import, so no
// animation code is fetched until the reader actually starts scrolling.
(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  if (reduced || !hasGsap) {
    root.classList.remove('gsap-pending');
    return;
  }

  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  // Capture the script URL now; document.currentScript is null in callbacks.
  const script = document.currentScript;
  const base = script ? new URL(script.src, location.href) : new URL(location.href);

  const TEXT = ['.k', 'h1', 'h2', 'h3', '.big', '.hero-intro'].join(',');
  const hero = document.getElementById('hero');
  const hidden = {
    opacity: 0,
    yPercent: 38,
    rotation: 1.4,
    clipPath: 'inset(0% 0% 100% 0%)',
    transformOrigin: '0% 100%',
  };

  if (hero) {
    const card = hero.querySelector(':scope > .card') || hero.querySelector('.card');
    const text = [...new Set([...hero.querySelectorAll(TEXT)])];
    if (card) {
      gsap.set(card, { opacity: 0, y: 18 });
      if (text.length) gsap.set(text, hidden);
      const intro = gsap
        .timeline({ defaults: { ease: 'expo.out' } })
        .to(card, { opacity: 1, y: 0, duration: 0.8 });
      if (text.length) {
        intro.to(
          text,
          {
            opacity: 1,
            yPercent: 0,
            rotation: 0,
            clipPath: 'inset(0% 0% 0% 0%)',
            duration: 1.1,
            stagger: 0.14,
          },
          0.1,
        );
      }
    }
  }

  // Initial states are set, so it is safe to show the document now.
  root.classList.remove('gsap-pending');

  let loaded = false;
  function loadCardMotion() {
    if (loaded) return;
    loaded = true;
    const moduleUrl = new URL('gsap-text.js', base);
    moduleUrl.search = base.search || '';
    import(moduleUrl.href)
      .then(({ initCardTextMotion }) => initCardTextMotion())
      .catch((error) => console.error('Card text animation failed to load:', error));
  }

  const firstCard = document.querySelector('.step:not(#hero)');
  if (firstCard) {
    ScrollTrigger.create({
      trigger: firstCard,
      start: 'top bottom+=600',
      once: true,
      onEnter: loadCardMotion,
    });
    // Deep links can start past the trigger; catch that case on boot.
    if (firstCard.getBoundingClientRect().top < window.innerHeight + 600) loadCardMotion();
  }

  const refresh = () => ScrollTrigger.refresh();
  window.addEventListener('load', refresh, { once: true });
  document.fonts?.ready.then(refresh);
  if ('ResizeObserver' in window) {
    let timer;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 200);
    }).observe(document.body);
  }
})();

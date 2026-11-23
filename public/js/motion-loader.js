// Boots the hero entrance immediately, then lazy-imports the card text module
// as the first story card approaches. ScrollTrigger drives the import, so no
// animation code is fetched until the reader actually starts scrolling.
(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  // Without GSAP there is nothing to animate. With reduced motion we still
  // run a short opacity-only fade so the reveal remains visible and gentle.
  if (!hasGsap) {
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
  const hidden = reduced
    ? { opacity: 0 }
    : {
        opacity: 0,
        yPercent: 38,
        rotation: 1.4,
        clipPath: 'inset(0% 0% 100% 0%)',
        transformOrigin: '0% 100%',
      };
  const shown = reduced
    ? { opacity: 1, duration: 0.35, ease: 'none' }
    : {
        opacity: 1,
        yPercent: 0,
        rotation: 0,
        clipPath: 'inset(0% 0% 0% 0%)',
        duration: 1.1,
        stagger: 0.14,
      };

  if (hero) {
    const card = hero.querySelector(':scope > .card') || hero.querySelector('.card');
    const text = [...new Set([...hero.querySelectorAll(TEXT)])];
    if (card) {
      gsap.set(card, reduced ? { opacity: 0 } : { opacity: 0, y: 18 });
      if (text.length) gsap.set(text, hidden);
      const intro = gsap.timeline({ defaults: { ease: 'expo.out' } }).to(
        card,
        reduced ? { opacity: 1, duration: 0.35, ease: 'none' } : { opacity: 1, y: 0, duration: 0.8 },
      );
      if (text.length) intro.to(text, shown, reduced ? 0 : 0.1);
    }
  }

  // The hero is ready, but keep later cards masked until their animation
  // module has applied the initial states.
  root.classList.add('hero-ready');

  let loaded = false;
  function loadCardMotion() {
    if (loaded) return;
    loaded = true;
    const moduleUrl = new URL('gsap-text.js', base);
    moduleUrl.search = base.search || '';
    import(moduleUrl.href)
      .then(({ initCardTextMotion }) => {
        initCardTextMotion();
        root.classList.remove('gsap-pending');
      })
      .catch((error) => {
        console.error('Card text animation failed to load:', error);
        root.classList.remove('gsap-pending');
      });
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
  } else {
    root.classList.remove('gsap-pending');
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

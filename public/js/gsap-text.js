// GSAP + ScrollTrigger entrance motion for every story card.
// Cues from Codrops' ThumbFullTransition: the headline is held in a soft clip
// mask, then lifted into place with a slight rotation while the supporting
// content follows on a stagger. Everything degrades to plain readable text.
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

  const TEXT = ['.k', 'h1', 'h2', 'h3', '.big', '.hero-intro'].join(',');
  const EXTRAS = [
    '.tiles .tile',
    '.team-kpi',
    '.summary-kpi',
    '.tier-row',
    '.comp',
    '.ward-row',
    '.amethi-ac-row',
  ].join(',');

  const unique = (nodes) => [...new Set(nodes)];
  const hiddenText = {
    opacity: 0,
    yPercent: 38,
    rotation: 1.4,
    clipPath: 'inset(0% 0% 100% 0%)',
    transformOrigin: '0% 100%',
  };
  const shownText = {
    opacity: 1,
    yPercent: 0,
    rotation: 0,
    clipPath: 'inset(0% 0% 0% 0%)',
  };

  const steps = [...document.querySelectorAll('.step')];
  const hero = document.getElementById('hero');
  const allTargets = [];

  try {
    // The opening card is already on screen, so animate it on load rather
    // than with a ScrollTrigger that would start at 100% progress.
    if (hero) {
      const card = hero.querySelector(':scope > .card') || hero.querySelector('.card');
      const text = unique([...hero.querySelectorAll(TEXT)]);
      if (card) {
        allTargets.push(card, ...text);
        gsap.set(card, { opacity: 0, y: 18 });
        if (text.length) gsap.set(text, hiddenText);
        const intro = gsap
          .timeline({ defaults: { ease: 'expo.out' } })
          .to(card, { opacity: 1, y: 0, duration: 0.8 });
        if (text.length) intro.to(text, { ...shownText, duration: 1.1, stagger: 0.14 }, 0.1);
      }
    }

    steps
      .filter((step) => step !== hero)
      .forEach((step) => {
        const card = step.querySelector(':scope > .card') || step.querySelector('.card');
        if (!card) return;

        const text = unique([...card.querySelectorAll(TEXT)]);
        const extras = [...card.querySelectorAll(EXTRAS)];
        allTargets.push(card, ...text, ...extras);

        gsap.set(card, { opacity: 0, y: 26 });
        if (text.length) gsap.set(text, hiddenText);
        if (extras.length) gsap.set(extras, { opacity: 0, y: 18 });

        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: step,
            start: 'top 82%',
            toggleActions: 'play none none none',
            once: true,
            invalidateOnRefresh: true,
          },
          defaults: { ease: 'expo.out' },
        });
        tl.to(card, { opacity: 1, y: 0, duration: 0.9 }, 0);
        if (text.length) tl.to(text, { ...shownText, duration: 1, stagger: 0.12 }, 0.08);
        if (extras.length) tl.to(extras, { opacity: 1, y: 0, duration: 0.7, stagger: 0.055 }, 0.2);
      });

    root.classList.remove('gsap-pending');

    // Fonts and lazily built sections change layout height; recalculate the
    // trigger positions once they settle.
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
  } catch (error) {
    console.error('GSAP text animation failed:', error);
    if (allTargets.length) gsap.set(allTargets, { clearProps: 'all' });
    root.classList.remove('gsap-pending');
  }
})();

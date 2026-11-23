// Lazily imported by motion-loader.js once the first story card approaches.
// Builds GSAP ScrollTrigger timelines for every remaining card: the headline
// lifts out of a clip mask while supporting content follows on a stagger.
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

const unique = (nodes) => [...new Set(nodes)];

export function initCardTextMotion() {
  const { gsap, ScrollTrigger } = window;
  if (!gsap || !ScrollTrigger) return;

  const hero = document.getElementById('hero');
  const steps = [...document.querySelectorAll('.step')].filter((step) => step !== hero);

  steps.forEach((step) => {
    const card = step.querySelector(':scope > .card') || step.querySelector('.card');
    if (!card) return;

    const text = unique([...card.querySelectorAll(TEXT)]);
    const extras = [...card.querySelectorAll(EXTRAS)];

    gsap.set(card, { opacity: 0, y: 26 });
    if (text.length) gsap.set(text, hiddenText);
    if (extras.length) gsap.set(extras, { opacity: 0, y: 18 });

    // ScrollTrigger owns the exact "card enters" moment; the timeline plays
    // once and then leaves the final state in the DOM.
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

  ScrollTrigger.refresh();
}

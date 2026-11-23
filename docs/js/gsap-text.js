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

const unique = (nodes) => [...new Set(nodes)];

export function initCardTextMotion() {
  const { gsap, ScrollTrigger } = window;
  if (!gsap || !ScrollTrigger) return;

  // Reduced motion gets a short opacity-only fade instead of the full clipped
  // lift, so the reveal is still perceptible without large movement.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hiddenText = reduced
    ? { opacity: 0 }
    : {
        opacity: 0,
        yPercent: 38,
        rotation: 1.4,
        clipPath: 'inset(0% 0% 100% 0%)',
        transformOrigin: '0% 100%',
      };
  const shownText = reduced
    ? { opacity: 1 }
    : {
        opacity: 1,
        yPercent: 0,
        rotation: 0,
        clipPath: 'inset(0% 0% 0% 0%)',
      };
  const fade = { duration: 0.35, ease: 'none' };

  const hero = document.getElementById('hero');
  const steps = [...document.querySelectorAll('.step')].filter((step) => step !== hero);

  steps.forEach((step) => {
    const card = step.querySelector(':scope > .card') || step.querySelector('.card');
    if (!card) return;

    const text = unique([...card.querySelectorAll(TEXT)]);
    const extras = [...card.querySelectorAll(EXTRAS)];

    gsap.set(card, reduced ? { opacity: 0 } : { opacity: 0, y: 26 });
    if (text.length) gsap.set(text, hiddenText);
    if (extras.length) gsap.set(extras, { opacity: 0, ...(reduced ? {} : { y: 18 }) });

    // Trigger on the card itself (not the full-height section). The card is
    // vertically centred in a 100vh step, so a step-based trigger fires while
    // the card is still a viewport away and the animation is missed.
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: card,
        start: 'top 88%',
        toggleActions: 'play none none none',
        once: true,
        invalidateOnRefresh: true,
      },
      defaults: { ease: 'expo.out' },
    });

    tl.to(card, reduced ? { opacity: 1, ...fade } : { opacity: 1, y: 0, duration: 0.9 }, 0);
    if (text.length) {
      tl.to(
        text,
        reduced
          ? { ...shownText, ...fade }
          : { ...shownText, duration: 1, stagger: 0.12 },
        0.08,
      );
    }
    if (extras.length) {
      tl.to(
        extras,
        reduced
          ? { opacity: 1, ...fade }
          : { opacity: 1, y: 0, duration: 0.7, stagger: 0.055 },
        0.2,
      );
    }
  });

  ScrollTrigger.refresh();
}

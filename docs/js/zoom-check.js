// A web page cannot change the browser's own zoom level. This script only
// detects a likely non-100% zoom and shows a small, dismissible reminder.
// Native display scaling produces "clean" devicePixelRatio values (1, 1.25,
// 1.5, 2, ...); browser zoom multiplies them and produces values like 0.8 or
// 1.6, which is the signal we use here.
(() => {
  const HINT_ID = 'zoom-hint';
  const DISMISS_KEY = 'ps-zoom-hint-dismissed';
  const CLEAN_RATIOS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];

  const isClean = (value) =>
    CLEAN_RATIOS.some((clean) => Math.abs(value - clean) < 0.03);

  function zoomLooksOff() {
    const dpr = window.devicePixelRatio || 1;
    if (!isClean(dpr)) return true;

    // A zoomed-out page is wider than the browser window reports. This is an
    // extra hint for cases where dpr happens to land on a clean value.
    const outer = window.outerWidth || 0;
    const inner = window.innerWidth || 0;
    return outer > 0 && inner > 0 && inner > outer * 1.06;
  }

  function dismissed() {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function rememberDismissal() {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Ignore storage errors (private mode, file://, etc.).
    }
  }

  function showHint() {
    if (document.getElementById(HINT_ID) || dismissed() || !zoomLooksOff()) return;

    const hint = document.createElement('aside');
    hint.id = HINT_ID;
    hint.className = 'zoom-hint';
    hint.setAttribute('role', 'status');
    hint.innerHTML =
      '<span>ज़ूम 100% पर सेट करें · Ctrl+0</span>' +
      '<button type="button" aria-label="सूचना बंद करें" title="बंद करें">×</button>';

    hint.querySelector('button').addEventListener('click', () => {
      hint.remove();
      rememberDismissal();
    });

    (document.body || document.documentElement).appendChild(hint);
    // Force the CSS transition/visible state on the next frame.
    requestAnimationFrame(() => hint.classList.add('on'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showHint, { once: true });
  } else {
    showHint();
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(showHint, 200);
  });
})();

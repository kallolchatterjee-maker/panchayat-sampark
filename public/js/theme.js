// Light/dark theme switch. The initial theme is applied by the small inline
// script in head.ejs to avoid a flash of the wrong colours; this file wires
// the button and remembers the reader's choice.
(function () {
  const STORAGE_KEY = 'ps-theme';
  const root = document.documentElement;
  const button = document.getElementById('theme-toggle');
  if (!button) return;

  const icon = button.querySelector('.theme-toggle-icon');
  const label = button.querySelector('.theme-toggle-text');

  function apply(theme, persist) {
    const light = theme === 'light';
    root.dataset.theme = light ? 'light' : 'dark';
    const action = light ? 'डार्क मोड' : 'लाइट मोड';
    button.setAttribute('aria-label', light ? 'डार्क मोड चालू करें' : 'लाइट मोड चालू करें');
    if (icon) icon.textContent = light ? '☾' : '☀';
    if (label) label.textContent = action;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, light ? 'light' : 'dark');
      } catch {
        // Storage can be blocked; the theme still applies for this visit.
      }
    }
    window.dispatchEvent(new CustomEvent('ps-themechange', { detail: { theme: root.dataset.theme } }));
  }

  apply(root.dataset.theme, false);
  button.addEventListener('click', () => {
    apply(root.dataset.theme === 'light' ? 'dark' : 'light', true);
  });
})();

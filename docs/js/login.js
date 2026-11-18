// One login page serves two deployments:
//  * the Express app — POST /login sets an HttpOnly, HMAC-signed session cookie;
//  * the static GitHub Pages build — a local flag satisfies the page gate.
// The server remains authoritative for the Express deployment.
(() => {
  const KEY = 'ps_auth';
  const TTL = 8 * 60 * 60 * 1000;
  const form = document.getElementById('login-form');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const error = document.getElementById('error');
  const params = new URLSearchParams(location.search);
  const next = params.get('next') || './';

  const show = (message) => {
    error.textContent = message;
    error.classList.add('on');
  };

  if (params.get('error')) show('उपयोगकर्ता नाम या पासवर्ड गलत है।');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.remove('on');
    if (username.value !== 'admin' || password.value !== 'admin123') {
      show('उपयोगकर्ता नाम या पासवर्ड गलत है।');
      password.select();
      return;
    }
    localStorage.setItem(KEY, String(Date.now() + TTL));
    try {
      // No-op on GitHub Pages; on Express this sets the session cookie.
      await fetch('./login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: username.value,
          password: password.value,
          next,
        }),
      });
    } catch {
      // Static hosting has no /login endpoint — the local flag is enough.
    }
    location.assign(next.startsWith('/') ? next : './');
  });
})();

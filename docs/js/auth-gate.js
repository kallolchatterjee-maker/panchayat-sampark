// Client-side gate used only by the static GitHub Pages snapshot.
// This is a demo lock, not access control: anyone can set the flag in devtools.
// The Express deployment protects the same routes with a signed cookie instead.
(() => {
  const KEY = 'ps_auth';
  const expiresAt = Number(localStorage.getItem(KEY) || 0);
  if (expiresAt > Date.now()) return;
  const login = new URL('login.html', new URL('.', location.href));
  login.searchParams.set('next', location.pathname + location.search);
  location.replace(login.toString());
})();

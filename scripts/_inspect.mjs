import { createApp } from '../server.mjs';

const { app } = createApp();
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/`);
  const html = await response.text();
  const bootJson = html.match(/id="boot">([\s\S]*?)<\/script>/)[1];
  const boot = JSON.parse(bootJson);
  console.log(
    'status',
    response.status,
    'html KB',
    (html.length / 1024).toFixed(0),
    'encoding',
    response.headers.get('content-encoding') || 'none',
  );
  console.log('boot acs', boot.acs.length, 'districts', boot.districts.length, 'pc', boot.pc.length, 'boot KB', (bootJson.length / 1024).toFixed(0));
  console.log('steps', (html.match(/class="step/g) || []).length);
  for (const marker of ['BOOTH SATURATION', '0.05°', 'Sambhal', 'Ayodhya', '8,76,980', 'village-match-report']) {
    console.log(marker, html.includes(marker));
  }
  const start = html.indexOf('BOOTH SATURATION');
  console.log(html.slice(start, start + 900).replace(/\s+/g, ' '));
  server.close();
});

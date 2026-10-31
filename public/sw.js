// Service worker: shows job notifications sent by the site, opens the post when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'New update', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'नई सरकारी नौकरी अपडेट', {
    body: d.body || '', icon: '/icon-192.png', badge: '/badge-72.png', image: d.image || undefined,
    data: { url: d.url || '/' }, tag: d.tag || 'new-jobs', renotify: true, lang: 'hi'
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (w.url === url && 'focus' in w) return w.focus();
    return self.clients.openWindow(url);
  })());
});

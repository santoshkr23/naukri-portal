// Job alerts: bell button + one-time invite. Push notifications when the browser supports them (every hour,
// even when closed); otherwise an hourly check while the site is open.
(() => {
  const LS = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const hasNotif = 'Notification' in window, hasSW = 'serviceWorker' in navigator, hasPush = hasSW && 'PushManager' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const btn = document.getElementById('alertBtn');
  let reg = null;

  const b64 = s => { const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function setBtn(on) {
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.querySelector('span').textContent = on ? 'Alerts on' : 'Job alerts';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'You get new-job notifications — tap to turn off' : 'Get a notification when new jobs are posted';
  }
  function toast(html, ms = 9000) {
    const t = document.createElement('div'); t.className = 'alert-toast'; t.setAttribute('role', 'status'); t.innerHTML = html;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms);
    t.addEventListener('click', e => { if (e.target.matches('.x')) t.remove(); });
  }

  async function pushSub() { return reg && hasPush ? reg.pushManager.getSubscription() : null; }

  async function subscribe() {
    if (!hasNotif) { toast('This browser does not support notifications. Join our Telegram channel instead.'); return; }
    if (isIOS && !standalone) { toast('<b>iPhone:</b> tap <b>Share → Add to Home Screen</b>, open the site from the new icon, then tap 🔔 again.', 15000); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked. Allow them in your browser\'s site settings to get job alerts.'); return; }
    LS.set('alerts', 'on'); LS.set('alerts_seen', new Date().toISOString());
    if (hasPush && reg) {
      try {
        const { publicKey } = await (await fetch('/push/key')).json();
        let sub = await reg.pushManager.getSubscription();
        if (sub && LS.get('alerts_key') !== publicKey) { await sub.unsubscribe(); sub = null; }
        sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
        await post('/push/subscribe', { subscription: sub.toJSON() });
        LS.set('alerts_key', publicKey); LS.set('alerts_mode', 'push');
      } catch (e) { LS.set('alerts_mode', 'tab'); }
    } else LS.set('alerts_mode', 'tab');
    setBtn(true);
    show({ title: '✅ Job alerts are on', body: 'You will get one notification an hour when new government jobs are posted.', url: '/' });
    hideInvite();
  }

  async function unsubscribe() {
    const sub = await pushSub();
    if (sub) { post('/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    LS.set('alerts', 'off'); setBtn(false); toast('Job alerts turned off.');
  }

  function show(n) {
    if (hasNotif && Notification.permission === 'granted') {
      const opts = { body: n.body, icon: '/icon-192.png', badge: '/badge-72.png', image: n.image, data: { url: n.url }, tag: 'new-jobs' };
      if (reg) return reg.showNotification(n.title, opts);
      try { const x = new Notification(n.title, opts); x.onclick = () => { location.href = n.url; }; return; } catch {}
    }
    toast(`<b>${n.title}</b><br>${String(n.body).replace(/\n/g, '<br>')} <a href="${n.url}">Open →</a> <button class="x" aria-label="Close">×</button>`);
  }

  // While the site is open: check every hour (push subscribers get it from the server instead)
  async function hourlyCheck() {
    if (LS.get('alerts') !== 'on' || LS.get('alerts_mode') === 'push' && await pushSub()) return;
    const last = Number(LS.get('alerts_checked') || 0);
    if (Date.now() - last < 3600e3) return;
    LS.set('alerts_checked', String(Date.now()));
    try {
      const since = LS.get('alerts_seen') || new Date(Date.now() - 3600e3).toISOString();
      const r = await (await fetch('/push/latest?since=' + encodeURIComponent(since))).json();
      LS.set('alerts_seen', r.now);
      if (!r.posts.length) return;
      if (r.posts.length === 1) show({ title: '🔔 ' + r.posts[0].title, body: 'नई अपडेट — पूरी जानकारी के लिए टैप करें', url: r.posts[0].url, image: r.posts[0].banner });
      else show({ title: `🔔 ${r.posts.length} नई सरकारी नौकरी अपडेट`, body: r.posts.slice(0, 3).map(p => '• ' + p.title).join('\n'), url: '/' });
    } catch {}
  }

  // One-time invite, shown after 20 seconds on a second page view
  function invite() {
    if (LS.get('alerts') || LS.get('alerts_invite') || !hasNotif || Notification.permission === 'denied') return;
    const views = Number(LS.get('views') || 0) + 1; LS.set('views', String(views));
    if (views < 2) return;
    setTimeout(() => {
      const d = document.createElement('div'); d.className = 'alert-invite'; d.id = 'alertInvite'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Job alerts');
      d.innerHTML = '<div class="ai-bell" aria-hidden="true">🔔</div><div><strong>नई सरकारी नौकरी की सूचना पाएं</strong><p>हर घंटे नई नौकरियों की एक सूचना — कोई स्पैम नहीं।</p></div>' +
        '<div class="ai-btns"><button type="button" class="ai-yes">Allow</button><button type="button" class="ai-no">Not now</button></div>';
      document.body.appendChild(d);
      d.querySelector('.ai-yes').onclick = () => { LS.set('alerts_invite', '1'); subscribe(); };
      d.querySelector('.ai-no').onclick = () => { LS.set('alerts_invite', String(Date.now())); hideInvite(); };
    }, 20000);
  }
  const hideInvite = () => document.getElementById('alertInvite')?.remove();

  btn?.addEventListener('click', async () => (btn.classList.contains('on') ? unsubscribe() : subscribe()));

  (async () => {
    if (hasSW) { try { reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; } catch {} }
    const on = LS.get('alerts') === 'on' && hasNotif && Notification.permission === 'granted';
    setBtn(on);
    // keep the server's list current (the server forgets subscribers if its storage is wiped) and follow key changes
    if (on && hasPush && reg) {
      try {
        const { publicKey } = await (await fetch('/push/key')).json();
        let sub = await reg.pushManager.getSubscription();
        if (!sub || LS.get('alerts_key') !== publicKey) { if (sub) await sub.unsubscribe(); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }); LS.set('alerts_key', publicKey); }
        await post('/push/subscribe', { subscription: sub.toJSON() }); LS.set('alerts_mode', 'push');
      } catch { LS.set('alerts_mode', 'tab'); }
    }
    invite();
    hourlyCheck(); setInterval(hourlyCheck, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) hourlyCheck(); });
  })();
})();

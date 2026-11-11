// "Turn on notifications" card. Works on Android/desktop Chrome, Edge, Firefox; on iPhone only after "Add to Home Screen".
(function () {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const card = document.getElementById('pushcard');
  if (!card) return;
  const T = JSON.parse(card.dataset.t);
  const msg = card.querySelector('.pmsg'), on = card.querySelector('.pon'), off = card.querySelector('.poff'), test = card.querySelector('.ptest');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const show = (state, text) => { card.dataset.state = state; msg.textContent = text; on.hidden = state !== 'off'; off.hidden = state !== 'on'; test.hidden = state !== 'on'; };
  const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };

  async function refresh() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return show('na', isIOS && !standalone ? T.ios : T.unsupported);
    }
    if (Notification.permission === 'denied') return show('blocked', T.blocked);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    show(sub ? 'on' : 'off', sub ? T.isOn : T.isOff);
  }
  on.addEventListener('click', async () => {
    on.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { on.disabled = false; return refresh(); }
      const { key } = await (await fetch('/push/key')).json();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await fetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
      await fetch('/push/test', { method: 'POST' });
    } catch (e) { msg.textContent = T.error + ' (' + e.message + ')'; }
    on.disabled = false; refresh();
  });
  off.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await fetch('/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
    refresh();
  });
  test.addEventListener('click', async () => { test.disabled = true; await fetch('/push/test', { method: 'POST' }); setTimeout(() => (test.disabled = false), 1500); });
  refresh();
})();

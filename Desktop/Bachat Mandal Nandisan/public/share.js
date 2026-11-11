// Share a list as an image (WhatsApp etc.). Buttons: <button data-share="#template" data-share-name="file">
(function () {
  let lib = null;
  const load = () => lib || (lib = new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/vendor/html2canvas.min.js'; s.onload = () => ok(window.html2canvas); s.onerror = bad; document.head.appendChild(s); }));
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-share]');
    if (!btn) return;
    const tpl = document.querySelector(btn.dataset.share);
    if (!tpl) return;
    const label = btn.innerHTML; btn.disabled = true; btn.textContent = '…';
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1';
    const card = tpl.content ? tpl.content.firstElementChild.cloneNode(true) : tpl.cloneNode(true);
    card.hidden = false; stage.appendChild(card); document.body.appendChild(stage);
    try {
      const h2c = await load();
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const canvas = await h2c(card, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const name = (btn.dataset.shareName || 'NBYM') + '-' + new Date().toISOString().slice(0, 10) + '.png';
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'NBYM' }); } catch (err) { if (err.name !== 'AbortError') throw err; }
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }
    } catch (err) { alert('Could not create image: ' + err.message); }
    stage.remove(); btn.disabled = false; btn.innerHTML = label;
  });
})();

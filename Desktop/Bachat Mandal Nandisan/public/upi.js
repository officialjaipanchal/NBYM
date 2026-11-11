// QR upload (resized on the phone before upload) and tap-to-copy UPI IDs
(function () {
  document.querySelectorAll('[data-qr-input]').forEach((inp) => {
    const box = inp.closest('.qrpick'); const out = box.querySelector('[data-qr-out]'); const prev = box.querySelector('[data-preview]');
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      const img = new Image();
      img.onload = () => {
        const max = 640, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.88); out.value = url; prev.src = url; prev.hidden = false; URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(f);
    });
  });
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('.copy[data-copy]'); if (!el) return;
    try { await navigator.clipboard.writeText(el.dataset.copy); const o = el.textContent; el.textContent = '✓ ' + o; setTimeout(() => (el.textContent = o), 1200); } catch (_) {}
  });
})();

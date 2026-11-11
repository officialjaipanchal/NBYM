// UPI helpers: deep link opens GPay / PhonePe / Paytm with payee and amount filled in.
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;
function valid(id) { return UPI_RE.test(String(id || '').trim()); }
function link(pa, pn, am, tn) {
  if (!valid(pa)) return null;
  const enc = (v) => encodeURIComponent(v);
  let u = `upi://pay?pa=${pa.trim()}&pn=${enc((pn || 'NBYM').slice(0, 40))}&cu=INR`; // keep '@' in pa as-is for UPI apps
  if (am) u += `&am=${(Math.round(am * 100) / 100).toFixed(2)}`;
  if (tn) u += `&tn=${enc(tn.slice(0, 60))}`;
  return u;
}
// Accept only small JPEG/PNG data URLs for QR images
function cleanQr(dataUrl) {
  const s = String(dataUrl || '');
  if (!s) return undefined;
  if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > 600000) return null;
  return s;
}
module.exports = { valid, link, cleanQr };

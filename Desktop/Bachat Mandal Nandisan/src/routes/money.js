// UPI details, "I have paid" claims, and year-end payouts.
const router = require('express').Router();
const { Group, Member, PayClaim, Payout, Year } = require('../models');
const calc = require('../lib/calc');
const upi = require('../lib/upi');
const push = require('../lib/push');
const payments = require('../lib/payments');
const { requireLogin, requireAdmin, flash, audit } = require('../lib/auth');
const rs = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

// ---------- family: save UPI ID / QR ----------
router.post('/my/upi', requireLogin, async (req, res) => {
  const { t } = res.locals;
  const g = await Group.findById(req.session.user.group);
  if (!g) return res.redirect('/');
  const id = String(req.body.upiId || '').trim();
  if (id && !upi.valid(id)) { flash(req, 'err', t('upiInvalid')); return res.redirect('/#upi'); }
  const qr = upi.cleanQr(req.body.upiQr);
  if (qr === null) { flash(req, 'err', t('qrInvalid')); return res.redirect('/#upi'); }
  g.upiId = id || undefined; g.upiName = String(req.body.upiName || '').trim().slice(0, 60) || undefined;
  if (qr) g.upiQr = qr;
  if (req.body.removeQr === 'on') g.upiQr = undefined;
  await g.save();
  await audit(req, 'upi.update', `${g.name}: ${g.upiId || '-'}${g.upiQr ? ' +QR' : ''}`);
  flash(req, 'ok', t('saved'));
  res.redirect('/#upi');
});

// ---------- family: "I have paid" ----------
router.post('/my/claim', requireLogin, async (req, res) => {
  const { t, settings } = res.locals;
  const year = await calc.getCurrentYear(settings);
  const members = await Member.find({ group: req.session.user.group, status: 'active' }, '_id');
  const mine = new Set(members.map((m) => String(m._id)));
  let picks = req.body.item || []; if (!Array.isArray(picks)) picks = [picks];
  const pending = await calc.pendingList(year, settings, members.map((m) => m._id));
  const open = new Set(pending.flatMap((p) => p.months.map((x) => `${p.member._id}|${x.month}`)));
  const already = await PayClaim.find({ group: req.session.user.group, status: 'pending' });
  const claimed = new Set(already.flatMap((c) => c.items.map((i) => `${i.member}|${i.month}`)));
  const items = picks.filter((k) => open.has(k) && !claimed.has(k) && mine.has(k.split('|')[0])).map((k) => { const [member, month] = k.split('|'); return { member, month }; });
  if (!items.length) { flash(req, 'err', t('claimNone')); return res.redirect('/'); }
  const c = await PayClaim.create({ year: year._id, group: req.session.user.group, user: req.session.user._id, items, amount: items.length * settings.monthlyAmount, paidOn: calc.parseDate(req.body.paidOn), ref: String(req.body.ref || '').trim().slice(0, 40) });
  await audit(req, 'claim.create', `${items.length} × ${settings.monthlyAmount} ref=${c.ref || '-'}`);
  const g = await Group.findById(req.session.user.group);
  await push.toAdmins((tt, lang) => ({ title: tt('pushClaimTitle'), body: tt('pushClaimBody', { f: lang === 'gu' && g.nameGu ? g.nameGu : g.name, a: rs(c.amount), n: items.length }), url: '/admin#claims', tag: 'claim' })).catch(() => {});
  flash(req, 'ok', t('claimSent'));
  res.redirect('/');
});
router.post('/my/claim/:id/cancel', requireLogin, async (req, res) => {
  await PayClaim.deleteOne({ _id: req.params.id, group: req.session.user.group, status: 'pending' });
  res.redirect('/');
});

// ---------- family: confirm payout received ----------
router.post('/my/payouts/:id/received', requireLogin, async (req, res) => {
  const p = await Payout.findOne({ _id: req.params.id, group: req.session.user.group }).populate('group');
  if (p && p.status !== 'received') {
    p.status = 'received'; p.receivedOn = new Date(); p.receivedBy = req.session.user._id; await p.save();
    await audit(req, 'payout.received', `${p.group.name} ${rs(p.net)}`);
    await push.toAdmins((tt, lang) => ({ title: tt('pushReceivedTitle'), body: tt('pushReceivedBody', { f: lang === 'gu' && p.group.nameGu ? p.group.nameGu : p.group.name, a: rs(p.net) }), url: '/admin/payouts', tag: 'payout' })).catch(() => {});
    flash(req, 'ok', res.locals.t('thanksConfirm'));
  }
  res.redirect('/');
});

// ---------- admin: approve / reject claims ----------
router.post('/admin/claims/:id/approve', requireAdmin, async (req, res) => {
  const { settings, t } = res.locals;
  const c = await PayClaim.findById(req.params.id).populate('group');
  if (!c || c.status !== 'pending') return res.redirect('/admin#claims');
  const year = await Year.findById(c.year);
  const created = await payments.record(year, settings, c.items.map((i) => ({ member: i.member, month: i.month, paidOn: c.paidOn })), req.session.user._id, c.ref ? 'UPI ' + c.ref : 'UPI');
  c.status = 'approved'; c.decidedBy = req.session.user._id; c.decidedAt = new Date(); await c.save();
  await audit(req, 'claim.approve', `${c.group.name}: ${created.length} payments ${c.ref || ''}`);
  flash(req, 'ok', `${t('claimApproved')} (${created.length})`);
  res.redirect(req.get('Referer') || '/admin#claims');
});
router.post('/admin/claims/:id/reject', requireAdmin, async (req, res) => {
  const c = await PayClaim.findById(req.params.id).populate('group');
  if (c && c.status === 'pending') {
    c.status = 'rejected'; c.reason = String(req.body.reason || '').slice(0, 120); c.decidedBy = req.session.user._id; c.decidedAt = new Date(); await c.save();
    await audit(req, 'claim.reject', `${c.group.name} ${c.reason}`);
    await push.toGroups([c.group._id], (tt) => ({ title: tt('pushClaimRejectTitle'), body: tt('pushClaimRejectBody', { a: rs(c.amount), r: c.reason || '—' }), url: '/', tag: 'claim' })).catch(() => {});
  }
  res.redirect(req.get('Referer') || '/admin#claims');
});

// ---------- admin: family UPI (edit from Families page) ----------
router.post('/admin/groups/:id/upi', requireAdmin, async (req, res) => {
  const g = await Group.findById(req.params.id);
  const id = String(req.body.upiId || '').trim();
  if (g && (!id || upi.valid(id))) { g.upiId = id || undefined; g.upiName = String(req.body.upiName || '').trim() || undefined; await g.save(); await audit(req, 'upi.update', `${g.name}: ${id || '-'}`); flash(req, 'ok', res.locals.t('saved')); }
  else flash(req, 'err', res.locals.t('upiInvalid'));
  res.redirect('/admin/groups#g' + req.params.id);
});

// ---------- admin: year-end payouts ----------
async function createPayouts(year) {
  let s = year.summary;
  if (!s || !s.families) { // older close without family summary: rebuild it from the stored payments
    const fresh = await require('./admin').yearSummary(year, await calc.getSettings());
    s = { ...(s || {}), ...fresh }; year.summary = s; year.markModified('summary'); await year.save();
  }
  let n = 0;
  for (const f of s.families) {
    if (!(f.net > 0)) continue;
    const rows = s.rows.filter((r) => r.groupId === f.groupId).map((r) => ({ name: r.name, nameGu: r.nameGu, deposited: r.deposited, dividend: r.dividend, nextDeduct: r.nextDeduct || 0, net: r.net ?? r.payout, eligible: r.eligible }));
    try { await Payout.create({ year: year._id, group: f.groupId, deposited: f.deposited, dividend: f.dividend, payout: f.payout, nextDeduct: f.nextDeduct || 0, net: f.net, rows }); n++; } catch (e) { if (e.code !== 11000) throw e; }
  }
  return { created: n, families: s.families.length, deposits: s.totals ? s.totals.deposits : 0 };
}
router.get('/admin/payouts', requireAdmin, async (req, res) => {
  const years = await Year.find({ status: 'closed' }).sort({ closedAt: -1 });
  const year = years.find((y) => String(y._id) === req.query.year) || years[0] || null;
  const list = year ? await Payout.find({ year: year._id }).populate('group') : [];
  list.sort((a, b) => (a.group?.order || 0) - (b.group?.order || 0));
  const sum = (st) => list.filter((p) => !st || p.status === st).reduce((a, p) => a + p.net, 0);
  res.render('admin/payouts', { years, year, list, upiLink: upi.link, totals: { all: sum(), pending: sum('pending'), paid: sum('paid'), received: sum('received') }, today: calc.todayIST() });
});
router.post('/admin/payouts/create', requireAdmin, async (req, res) => {
  const year = await Year.findById(req.body.year);
  const { t } = res.locals;
  const r = year ? await createPayouts(year) : { created: 0, families: 0, deposits: 0 };
  await audit(req, 'payout.create', `${year?.label}: ${r.created}`);
  if (r.created) flash(req, 'ok', t('payoutsCreated', { n: r.created }));
  else flash(req, 'warn', r.deposits > 0 ? t('payoutsNoneNet') : t('payoutsNoneZero', { y: year?.label || '' }));
  res.redirect('/admin/payouts?year=' + (year?._id || ''));
});
router.post('/admin/payouts/:id/paid', requireAdmin, async (req, res) => {
  const p = await Payout.findById(req.params.id).populate('group');
  if (p && p.status === 'pending') {
    p.status = 'paid'; p.paidOn = calc.parseDate(req.body.paidOn); p.method = req.body.method === 'cash' ? 'cash' : 'upi'; p.ref = String(req.body.ref || '').slice(0, 40); p.paidBy = req.session.user._id; await p.save();
    await audit(req, 'payout.paid', `${p.group.name} ${rs(p.net)} ${p.method} ${p.ref}`);
    await push.toGroups([p.group._id], (tt) => ({ title: tt('pushPayoutTitle'), body: tt('pushPayoutBody', { a: rs(p.net) }), url: '/#payout', tag: 'payout' })).catch(() => {});
  }
  res.redirect('/admin/payouts?year=' + p?.year + '#p' + req.params.id);
});
router.post('/admin/payouts/:id/undo', requireAdmin, async (req, res) => {
  const p = await Payout.findById(req.params.id).populate('group');
  if (p) { p.status = 'pending'; p.paidOn = p.receivedOn = undefined; p.ref = p.method = undefined; await p.save(); await audit(req, 'payout.undo', p.group.name); }
  res.redirect('/admin/payouts?year=' + p?.year + '#p' + req.params.id);
});

module.exports = router;
module.exports.createPayouts = createPayouts;

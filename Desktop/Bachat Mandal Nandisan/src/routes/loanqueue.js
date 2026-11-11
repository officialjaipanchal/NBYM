// Loan request queue: families apply, guarantors consent, admin approves in order (first come, first served).
const router = require('express').Router();
const { LoanRequest, Member, Group, Loan } = require('../models');
const calc = require('../lib/calc');
const loans = require('../lib/loans');
const push = require('../lib/push');
const { requireLogin, requireAdmin, flash, audit } = require('../lib/auth');
const rs = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const nm = (m, lang) => (lang === 'gu' && m.nameGu ? m.nameGu : m.name);

async function queue() {
  return LoanRequest.find({ status: 'waiting' }).sort({ createdAt: 1 }).populate('borrower group guarantors.member');
}

// ---------- family: apply ----------
router.post('/my/loan-request', requireLogin, async (req, res) => {
  const { t, settings } = res.locals;
  const u = req.session.user;
  const fail = (k, v) => { flash(req, 'err', t(k, v)); res.redirect('/#loanreq'); };
  const borrower = await Member.findOne({ _id: req.body.borrower, group: u.group, status: 'active' });
  if (!borrower) return fail('err_inactive');
  const amount = Math.round(Number(req.body.amount) || 0);
  const g1 = req.body.g1, g2 = req.body.g2;
  if (await LoanRequest.exists({ borrower: borrower._id, status: 'waiting' })) return fail('lrAlready');
  const err = await loans.check({ borrower: borrower._id, g1, g2, amount }, settings);
  if (err) return fail(err.key, err.vars);
  const r = await LoanRequest.create({ group: u.group, user: u._id, borrower: borrower._id, amount, reason: String(req.body.reason || '').slice(0, 200), guarantors: [{ member: g1 }, { member: g2 }] });
  await audit(req, 'loanreq.create', `${borrower.name} ${rs(amount)}`);
  const pos = (await queue()).findIndex((x) => String(x._id) === String(r._id)) + 1;
  // Ask the two guarantors' families; tell admins
  const gms = await Member.find({ _id: { $in: [g1, g2] } });
  await push.toGroups(gms.map((m) => m.group), (tt, lang) => ({ title: tt('pushGuarAskTitle'), body: tt('pushGuarAskBody', { b: nm(borrower, lang), a: rs(amount) }), url: '/#guarantee', tag: 'guar' })).catch(() => {});
  await push.toAdmins((tt, lang) => ({ title: tt('pushLrTitle'), body: tt('pushLrBody', { b: nm(borrower, lang), a: rs(amount), p: pos }), url: '/admin/loans#queue', tag: 'loanreq' })).catch(() => {});
  flash(req, 'ok', t('lrSent', { p: pos }));
  res.redirect('/#loanreq');
});

router.post('/my/loan-request/:id/cancel', requireLogin, async (req, res) => {
  const r = await LoanRequest.findOne({ _id: req.params.id, group: req.session.user.group, status: 'waiting' }).populate('borrower');
  if (r) { r.status = 'cancelled'; r.decidedAt = new Date(); await r.save(); await audit(req, 'loanreq.cancel', r.borrower?.name); }
  res.redirect('/#loanreq');
});

// ---------- guarantor family: accept / decline ----------
router.post('/my/guarantee/:id', requireLogin, async (req, res) => {
  const { t } = res.locals;
  const r = await LoanRequest.findOne({ _id: req.params.id, status: 'waiting' }).populate('borrower guarantors.member');
  if (!r) return res.redirect('/');
  const mine = r.guarantors.filter((g) => g.member && String(g.member.group) === String(req.session.user.group) && g.status === 'asked');
  const accept = req.body.answer === 'accept';
  for (const g of mine) { g.status = accept ? 'accepted' : 'declined'; g.at = new Date(); }
  if (mine.length) {
    r.markModified('guarantors'); await r.save();
    await audit(req, 'loanreq.guarantor', `${r.borrower.name}: ${accept ? 'accepted' : 'declined'}`);
    await push.toGroups([r.group], (tt, lang) => ({ title: accept ? tt('pushGuarYesTitle') : tt('pushGuarNoTitle'), body: tt(accept ? 'pushGuarYesBody' : 'pushGuarNoBody', { g: mine.map((g) => nm(g.member, lang)).join(', ') }), url: '/#loanreq', tag: 'loanreq' })).catch(() => {});
    flash(req, 'ok', accept ? t('guarThanks') : t('guarDeclined'));
  }
  res.redirect('/');
});

// ---------- admin: approve / reject ----------
router.post('/admin/loan-requests/:id/approve', requireAdmin, async (req, res) => {
  const { t, settings } = res.locals;
  const r = await LoanRequest.findById(req.params.id).populate('borrower');
  if (!r || r.status !== 'waiting') return res.redirect('/admin/loans#queue');
  const year = await calc.getCurrentYear(settings);
  const out = await loans.create({ borrower: r.borrower._id, g1: r.guarantors[0]?.member, g2: r.guarantors[1]?.member, amount: Number(req.body.amount) || r.amount, reason: r.reason, date: calc.parseDate(req.body.date) }, settings, year);
  if (out.err) { flash(req, 'err', t(out.err.key, out.err.vars)); return res.redirect('/admin/loans#queue'); }
  r.status = 'approved'; r.loan = out.loan._id; r.decidedAt = new Date(); r.decidedBy = req.session.user._id; r.note = String(req.body.note || '').slice(0, 200); await r.save();
  await audit(req, 'loanreq.approve', `${r.borrower.name} ${rs(out.loan.amount)}${req.body.skipped ? ' (out of queue order: ' + req.body.skipReason + ')' : ''}`);
  await push.toGroups([r.group], (tt) => ({ title: tt('pushLrOkTitle'), body: tt('pushLrOkBody', { a: rs(out.loan.amount) }), url: '/#myloans', tag: 'loanreq' })).catch(() => {});
  flash(req, 'ok', t('lrApproved'));
  res.redirect('/admin/loans/' + out.loan._id);
});
router.post('/admin/loan-requests/:id/reject', requireAdmin, async (req, res) => {
  const r = await LoanRequest.findById(req.params.id).populate('borrower');
  if (r && r.status === 'waiting') {
    r.status = 'rejected'; r.note = String(req.body.note || '').slice(0, 200); r.decidedAt = new Date(); r.decidedBy = req.session.user._id; await r.save();
    await audit(req, 'loanreq.reject', `${r.borrower.name} ${r.note}`);
    await push.toGroups([r.group], (tt) => ({ title: tt('pushLrNoTitle'), body: tt('pushLrNoBody', { a: rs(r.amount), r: r.note || '—' }), url: '/#loanreq', tag: 'loanreq' })).catch(() => {});
  }
  res.redirect('/admin/loans#queue');
});

module.exports = router;
module.exports.queue = queue;

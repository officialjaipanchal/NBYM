// Rule 22: death help fund. Visible to everyone (it is a community collection); only admin can edit.
const router = require('express').Router();
const { Sahay, Member, Group, Contribution } = require('../models');
const calc = require('../lib/calc');
const { requireLogin, requireAdmin, flash, audit } = require('../lib/auth');

function stats(s) {
  const paid = new Set(s.payments.map((p) => String(p.member)));
  const collected = s.payments.reduce((a, p) => a + p.amount, 0);
  const expected = s.contributors.length * s.amountPerMember;
  return { paid, collected, expected, remaining: expected - collected, paidCount: paid.size, total: s.contributors.length };
}

router.get('/sahay', requireLogin, async (req, res) => {
  const list = await Sahay.find().populate('deceased recipient').sort({ status: 1, dateOfDeath: -1 });
  const rows = list.map((s) => ({ s, st: stats(s) }));
  const members = await Member.find({ status: 'active' }).sort({ srNo: 1 });
  const allMembers = await Member.find({ status: { $ne: 'deceased' } }).populate('group').sort({ srNo: 1 });
  res.render('sahay-list', { allMembers, rows, members, today: calc.todayIST() });
});

router.get('/sahay/:id', requireLogin, async (req, res) => {
  const s = await Sahay.findById(req.params.id).populate('deceased recipient');
  if (!s) return res.redirect('/sahay');
  const st = stats(s);
  const groups = await Group.find().sort({ order: 1, name: 1 });
  const members = await Member.find({ _id: { $in: s.contributors } }).sort({ srNo: 1 });
  let deposit = null;
  if (req.session.user.role === 'admin') {
    const year = await calc.getCurrentYear(res.locals.settings);
    deposit = (await Contribution.find({ year: year._id, member: s.deceased._id })).reduce((a, c) => a + c.amount, 0);
  }
  const payOn = Object.fromEntries(s.payments.map((p) => [String(p.member), p]));
  const family = await Member.find({ group: s.deceased.group, _id: { $ne: s.deceased._id } }).sort({ srNo: 1 });
  const recChoices = family.length ? family : await Member.find({ status: { $ne: 'deceased' } }).sort({ srNo: 1 });
  res.render('sahay', { recChoices, s, st, groups, members, payOn, deposit, today: calc.todayIST() });
});

router.post('/sahay', requireAdmin, async (req, res) => {
  const settings = res.locals.settings;
  const dead = await Member.findById(req.body.deceased);
  if (!dead) return res.redirect('/sahay');
  dead.status = 'deceased'; await dead.save();
  const contributors = (await Member.find({ status: 'active', _id: { $ne: dead._id } }, '_id')).map((m) => m._id);
  const rec = req.body.recipient ? await Member.findById(req.body.recipient).populate('group') : null;
  if (!rec || String(rec._id) === String(dead._id)) { flash(req, 'err', res.locals.t('recipient') + '?'); return res.redirect('/sahay'); }
  const s = await Sahay.create({ recipient: rec._id, recipientName: rec.name, recipientMobile: rec.mobile || rec.group?.mobile,
    deceased: dead._id, dateOfDeath: calc.parseDate(req.body.dateOfDeath),
    amountPerMember: Number(req.body.amountPerMember) || settings.insuranceAmount,
    contributors, note: req.body.note,
  });
  await audit(req, 'sahay.create', `${dead.name}, ${contributors.length} members × ${s.amountPerMember}`);
  await require('../lib/push').toAll((t, lang) => ({
    title: t('pushSahayTitle'),
    body: t('pushSahayBody', { n: lang === 'gu' && dead.nameGu ? dead.nameGu : dead.name, a: '₹' + s.amountPerMember }),
    url: '/sahay/' + s._id, tag: 'sahay',
  })).catch(() => {});
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/sahay/' + s._id);
});

router.post('/sahay/:id/pay', requireAdmin, async (req, res) => {
  const s = await Sahay.findById(req.params.id).populate('deceased recipient');
  if (!s) return res.redirect('/sahay');
  let ids = req.body.pay || []; if (!Array.isArray(ids)) ids = [ids];
  const already = new Set(s.payments.map((p) => String(p.member)));
  const allowed = new Set(s.contributors.map(String));
  const paidOn = calc.parseDate(req.body.paidOn);
  let n = 0;
  for (const id of ids) if (allowed.has(id) && !already.has(id)) { s.payments.push({ member: id, amount: s.amountPerMember, paidOn }); n++; }
  await s.save();
  await audit(req, 'sahay.pay', `${s.deceased.name}: ${n} payments`);
  flash(req, 'ok', `${res.locals.t('saved')} (${n})`);
  res.redirect('/sahay/' + s._id);
});

router.post('/sahay/:id/undo/:pid', requireAdmin, async (req, res) => {
  const s = await Sahay.findById(req.params.id);
  const p = s && s.payments.id(req.params.pid);
  if (p) { p.deleteOne(); await s.save(); await audit(req, 'sahay.undo', String(s._id)); }
  res.redirect('/sahay/' + req.params.id);
});

router.post('/sahay/:id/give', requireAdmin, async (req, res) => {
  const s = await Sahay.findById(req.params.id).populate('deceased recipient');
  if (!s) return res.redirect('/sahay');
  s.status = 'given'; s.givenOn = calc.parseDate(req.body.givenOn); s.givenAmount = Number(req.body.givenAmount) || stats(s).collected;
  if (req.body.recipient) {
    const rec = await Member.findById(req.body.recipient).populate('group');
    if (rec) { s.recipient = rec._id; s.recipientName = rec.name; s.recipientMobile = rec.mobile || rec.group?.mobile; }
  }
  s.note = req.body.note || s.note;
  await s.save();
  await audit(req, 'sahay.given', `${s.deceased.name} → ${s.recipientName} ₹${s.givenAmount}`);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/sahay/' + s._id);
});

router.post('/sahay/:id/delete', requireAdmin, async (req, res) => {
  const s = await Sahay.findById(req.params.id).populate('deceased recipient');
  if (s) {
    await s.deleteOne();
    let restored = false;
    if (req.body.restore === 'on' && s.deceased && s.deceased.status === 'deceased') {
      s.deceased.status = 'active'; await s.deceased.save(); restored = true;
    }
    await audit(req, 'sahay.delete', `${s.deceased?.name}, ${s.payments.length} payments ₹${s.payments.reduce((a, p) => a + p.amount, 0)}${restored ? ', member set active' : ''}`);
    flash(req, 'ok', res.locals.t('deleted'));
  }
  res.redirect('/sahay');
});

module.exports = router;

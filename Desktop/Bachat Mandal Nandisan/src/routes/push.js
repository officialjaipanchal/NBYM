const router = require('express').Router();
const express = require('express');
const { PushSub, Group } = require('../models');
const push = require('../lib/push');
const calc = require('../lib/calc');
const { requireLogin, requireAdmin, flash, audit } = require('../lib/auth');

router.get('/push/key', requireLogin, async (req, res) => {
  const s = await push.keys();
  res.json({ key: s.vapidPublic });
});

router.post('/push/subscribe', requireLogin, express.json(), async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ ok: false });
  const u = req.session.user;
  await PushSub.findOneAndUpdate({ endpoint: sub.endpoint }, {
    endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    user: u._id, group: u.group || undefined, role: u.role, lang: req.session.lang || 'gu', ua: String(req.get('user-agent') || '').slice(0, 200),
  }, { upsert: true });
  await audit(req, 'push.subscribe', String(req.get('user-agent') || '').slice(0, 60));
  res.json({ ok: true });
});

router.post('/push/unsubscribe', requireLogin, express.json(), async (req, res) => {
  if (req.body && req.body.endpoint) await PushSub.deleteOne({ endpoint: req.body.endpoint, user: req.session.user._id });
  res.json({ ok: true });
});

router.post('/push/test', requireLogin, async (req, res) => {
  const r = await push.sendTo({ user: req.session.user._id }, (t) => ({ title: 'NBYM', body: t('pushTestBody'), url: '/' }));
  res.json(r);
});

// ---- Admin: send a notice ----
router.get('/admin/notify', requireAdmin, async (req, res) => {
  const subs = await PushSub.find().populate('group');
  const families = new Set(subs.filter((s) => s.group).map((s) => String(s.group._id)));
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const pending = await calc.pendingList(year, settings);
  const pendingFamilies = new Set(pending.map((p) => String(p.member.group?._id || p.member.group)));
  const reachablePending = [...pendingFamilies].filter((g) => families.has(g)).length;
  res.render('admin/notify', { groupsTotal: await Group.countDocuments(), devices: subs.length, familyCount: families.size, pendingFamilies: pendingFamilies.size, reachablePending, subs });
});

router.post('/admin/notify', requireAdmin, async (req, res) => {
  const { t } = res.locals;
  const audience = req.body.audience;
  let r;
  if (audience === 'pending') r = await push.sendPendingReminders();
  else {
    const title = String(req.body.title || '').trim().slice(0, 80) || 'NBYM';
    const body = String(req.body.body || '').trim().slice(0, 300);
    if (!body) { flash(req, 'err', t('pushNeedBody')); return res.redirect('/admin/notify'); }
    const msg = () => ({ title, body, url: '/', tag: 'notice' });
    r = audience === 'admins' ? await push.toAdmins(msg) : await push.toAll(msg);
  }
  await audit(req, 'push.send', `${audience}: ${r.sent} sent`);
  flash(req, r.sent ? 'ok' : 'warn', t('pushSent', { n: r.sent }));
  res.redirect('/admin/notify');
});

router.post('/admin/notify/settings', requireAdmin, async (req, res) => {
  const s = await calc.getSettings();
  s.autoReminders = req.body.autoReminders === 'on';
  s.reminderDays = String(req.body.reminderDays || '').split(/[ ,]+/).map(Number).filter((d) => d >= 1 && d <= 28).slice(0, 6);
  await s.save();
  await audit(req, 'push.settings', `${s.autoReminders} ${s.reminderDays.join(',')}`);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/notify');
});

// ---- Daily automatic reminders (Vercel Cron calls this once a day) ----
router.get('/cron/reminders', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const okAuth = secret ? req.get('authorization') === `Bearer ${secret}` : /vercel-cron/i.test(req.get('user-agent') || '');
  if (!okAuth) return res.status(401).json({ ok: false });
  const s = await calc.getSettings();
  const today = calc.todayIST();
  const key = calc.dateInput(today);
  if (!s.autoReminders || !s.reminderDays.includes(today.getUTCDate()) || s.remindersSentOn === key) return res.json({ ok: true, skipped: true });
  s.remindersSentOn = key; await s.save();
  const r = await push.sendPendingReminders();
  res.json({ ok: true, ...r });
});

module.exports = router;

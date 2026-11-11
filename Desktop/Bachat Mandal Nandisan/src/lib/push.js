// Free phone notifications (Web Push). Keys are created once and stored in Settings.
const webpush = require('web-push');
const { PushSub, User } = require('../models');
const calc = require('./calc');
const { makeT } = require('./i18n');

async function keys() {
  const s = await calc.getSettings();
  if (!s.vapidPublic || !s.vapidPrivate) {
    const k = webpush.generateVAPIDKeys();
    s.vapidPublic = k.publicKey; s.vapidPrivate = k.privateKey; await s.save();
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:nbym-admin@example.com', s.vapidPublic, s.vapidPrivate);
  return s;
}

// msg: (t, lang) => ({ title, body, url })  — built per device language
async function sendTo(query, msg) {
  const subs = await PushSub.find(query);
  if (!subs.length) return { sent: 0, failed: 0, devices: 0 };
  await keys();
  let sent = 0, failed = 0;
  await Promise.allSettled(subs.map(async (s) => {
    const m = msg(makeT(s.lang), s.lang);
    const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url || '/', tag: m.tag });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 60 * 60 * 24 * 3, timeout: 8000 });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 404 || e.statusCode === 410) await PushSub.deleteOne({ _id: s._id }); // phone unsubscribed
      else console.error('push failed', e.statusCode || '', e.message);
    }
  }));
  return { sent, failed, devices: subs.length };
}

const toGroups = (groupIds, msg) => sendTo({ group: { $in: groupIds } }, msg);
const toAll = (msg) => sendTo({}, msg);
async function toAdmins(msg) {
  const ids = (await User.find({ role: 'admin', active: true }, '_id')).map((u) => u._id);
  return sendTo({ user: { $in: ids } }, msg);
}

// Payment reminders for families that still owe (used by the admin button and the daily cron)
async function sendPendingReminders() {
  const settings = await calc.getSettings();
  const year = await calc.getCurrentYear(settings);
  const pending = await calc.pendingList(year, settings);
  const byGroup = new Map();
  for (const p of pending) {
    const g = String(p.member.group?._id || p.member.group);
    const x = byGroup.get(g) || { n: 0, amount: 0, fine: 0, months: new Set() };
    x.n++; x.amount += p.amount; x.fine += p.fine; p.months.forEach((m) => x.months.add(m.month));
    byGroup.set(g, x);
  }
  const { monthLabel } = require('./i18n');
  const money = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  let sent = 0, devices = 0;
  for (const [g, x] of byGroup) {
    const r = await sendTo({ group: g }, (t, lang) => ({
      title: t('pushReminderTitle'),
      body: t('pushReminderBody', { n: x.n, m: [...x.months].sort().map((k) => monthLabel(lang, k)).join(', '), a: money(x.amount) + (x.fine ? ' + ' + money(x.fine) : ''), d: settings.dueDay }),
      url: '/', tag: 'reminder',
    }));
    sent += r.sent; devices += r.devices;
  }
  return { families: byGroup.size, sent, devices };
}

module.exports = { keys, sendTo, toGroups, toAll, toAdmins, sendPendingReminders };

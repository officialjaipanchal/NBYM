// Recording monthly payments in one place (used by admin ticks and by approved UPI claims)
const { Contribution, Member } = require('../models');
const calc = require('./calc');
const push = require('./push');
const { monthLabel } = require('./i18n');
const rs = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

// items: [{ member, month, paidOn, noLate }]
async function record(year, settings, items, userId, note) {
  const created = [];
  for (const it of items) {
    const lateFee = it.noLate ? 0 : calc.lateFeeFor(settings.monthlyAmount, it.month, it.paidOn, settings);
    try {
      await Contribution.create({ year: year._id, member: it.member, month: it.month, amount: settings.monthlyAmount, paidOn: it.paidOn, lateFee, note, recordedBy: userId });
      created.push({ member: String(it.member), month: it.month, lateFee });
    } catch (e) { if (e.code !== 11000) throw e; }
  }
  if (created.length) {
    const ms = await Member.find({ _id: { $in: created.map((c) => c.member) } }, 'group');
    const gOf = Object.fromEntries(ms.map((m) => [String(m._id), String(m.group)]));
    const byG = new Map();
    for (const c of created) { const g = gOf[c.member]; const v = byG.get(g) || { n: 0, fee: 0, months: new Set() }; v.n++; v.fee += c.lateFee; v.months.add(c.month); byG.set(g, v); }
    await Promise.allSettled([...byG].map(([g, v]) => push.toGroups([g], (t, lang) => ({
      title: t('pushPaidTitle'),
      body: t('pushPaidBody', { a: rs(v.n * settings.monthlyAmount), m: [...v.months].sort().map((k) => monthLabel(lang, k)).join(', '), n: v.n }) + (v.fee ? ' + ' + t('lateFee') + ' ' + rs(v.fee) : ''),
      url: '/', tag: 'paid',
    }))));
  }
  return created;
}
module.exports = { record };

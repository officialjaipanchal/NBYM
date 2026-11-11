// Loan rules in one place (used by admin "new loan" and by approving a queued request)
const { Loan, Member } = require('../models');
const calc = require('./calc');

async function busyGuarantors(excludeLoanId) {
  const q = { status: 'active' };
  if (excludeLoanId) q._id = { $ne: excludeLoanId };
  const loans = await Loan.find(q, 'guarantors');
  return new Set(loans.flatMap((l) => l.guarantors.map(String)));
}

// Returns an error key + vars, or null when the loan is allowed (Rules 7, 11, 12, 14)
async function check({ borrower, g1, g2, amount }, settings) {
  const b = await Member.findById(borrower);
  if (!b || b.status !== 'active' || !(amount > 0)) return { key: 'err_inactive' };
  if (!g1 || !g2 || String(g1) === String(g2) || String(g1) === String(borrower) || String(g2) === String(borrower)) return { key: 'err_twoGuarantors' };
  const gs = await Member.find({ _id: { $in: [g1, g2] }, status: 'active' });
  if (gs.length !== 2) return { key: 'err_twoGuarantors' };
  const busy = await busyGuarantors();
  for (const g of gs) if (busy.has(String(g._id))) return { key: 'err_guarantorBusy', vars: { n: g.name } };
  const existing = await Loan.find({ borrower, status: 'active' });
  const already = existing.reduce((a, l) => a + calc.loanState(l).principal, 0);
  if (already + amount > settings.maxLoan) return { key: 'err_maxLoan', vars: { n: settings.maxLoan.toLocaleString('en-IN') } };
  return null;
}

async function create({ borrower, g1, g2, amount, date, reason, rate, ratePeriod }, settings, year) {
  const err = await check({ borrower, g1, g2, amount }, settings);
  if (err) return { err };
  const loan = await Loan.create({
    year: year._id, borrower, guarantors: [g1, g2], amount, date, reason,
    rate: Number.isFinite(rate) ? rate : settings.interestRate,
    ratePeriod: ['monthly', 'yearly'].includes(ratePeriod) ? ratePeriod : settings.interestPeriod,
  });
  return { loan };
}

module.exports = { busyGuarantors, check, create };

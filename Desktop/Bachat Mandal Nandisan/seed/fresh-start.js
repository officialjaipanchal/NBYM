// Start a clean year from Besta Varsh, keeping families, members, logins and settings.
// Deletes ALL payments, loans and other entries of older years.
// Usage: npm run fresh-start -- --yes
require('dotenv').config();
const mongoose = require('mongoose');
const M = require('../src/models');
const { buildMonths } = require('../src/lib/calc');

(async () => {
  if (!process.argv.includes('--yes')) {
    console.log('This deletes all payments, loans and ledger entries and starts year 2026-27 from Besta Varsh (10-Nov-2026).');
    console.log('Families, members, logins and settings are kept. Run again with:  npm run fresh-start -- --yes');
    process.exit(0);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'bachat_mandal' });
  const r = await Promise.all([M.Contribution.deleteMany({}), M.Loan.deleteMany({}), M.Ledger.deleteMany({}), M.Year.deleteMany({}), M.PayClaim.deleteMany({}), M.Payout.deleteMany({}), M.LoanRequest.deleteMany({})]);
  const year = await M.Year.create({ label: '2026-27 (સંવત 2083)', startDate: new Date('2026-11-10T00:00:00Z'), months: buildMonths('2026-11', 12) });
  await M.Settings.updateOne({ key: 'main' }, { $set: { currentYear: year._id } }, { upsert: true });
  await M.Audit.create({ username: 'system', action: 'year.fresh-start', details: `Removed ${r[0].deletedCount} payments, ${r[1].deletedCount} loans, ${r[2].deletedCount} ledger entries` });
  console.log(`Done. Year ${year.label} started fresh. Removed ${r[0].deletedCount} payments, ${r[1].deletedCount} loans.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

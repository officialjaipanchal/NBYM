// Usage: npm run seed            (only runs on an empty database)
//        npm run seed -- --force (WIPES all mandal data and re-seeds)
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const M = require('../src/models');
const { buildMonths } = require('../src/lib/calc');
const data = require('./members');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'bachat_mandal' });
  const force = process.argv.includes('--force');
  if ((await M.Member.countDocuments()) && !force) {
    console.log('Database already has members. Use "npm run seed -- --force" to wipe and re-seed.');
    process.exit(0);
  }
  if (force) for (const k of ['Settings', 'Year', 'Group', 'Member', 'User', 'Contribution', 'Loan', 'Ledger', 'Audit', 'Sahay']) await M[k].deleteMany({});

  // Accounting year starts on Besta Varsh (Gujarati New Year, VS 2083) = 10-Nov-2026; months Nov-26 .. Oct-27
  const year = await M.Year.create({ label: '2026-27 (સંવત 2083)', startDate: new Date('2026-11-10T00:00:00Z'), months: buildMonths('2026-11', 12) });
  const settings = await M.Settings.create({ key: 'main', currentYear: year._id });

  const adminPass = process.env.ADMIN_PASSWORD || crypto.randomBytes(5).toString('hex');

  let order = 0, members = 0, payments = 0;
  for (const g of data) {
    const [, headName, headGu] = g.members[0];
    const group = await M.Group.create({ name: headName, nameGu: headGu, mobile: g.mobile, order: ++order });
    for (let i = 0; i < g.members.length; i++) {
      const [srNo, name, nameGu, mob] = g.members[i];
      const m = await M.Member.create({ srNo, name, nameGu, mobile: i === 0 ? g.mobile : mob, group: group._id });
      if (i === 0) { group.head = m._id; await group.save(); }
      members++;
    }
    // One login per family: username = head mobile, first password = mobile (must change on first login)
    await M.User.create({ username: g.mobile, passwordHash: await bcrypt.hash(g.mobile, 10), role: 'user', group: group._id, displayName: headName, mustChangePassword: true });
  }
  // Admin login. Set ADMIN_MEMBER_SR in .env (e.g. 21) to link it to that member; or link later in Logins page.
  const adminMember = process.env.ADMIN_MEMBER_SR ? await M.Member.findOne({ srNo: Number(process.env.ADMIN_MEMBER_SR) }) : null;
  await M.User.create({ username: 'admin', passwordHash: await bcrypt.hash(adminPass, 10), role: 'admin', member: adminMember?._id, displayName: adminMember?.name || 'Admin', mustChangePassword: !process.env.ADMIN_PASSWORD });
  console.log(`Seeded ${data.length} families, ${members} members. Year ${year.label} starts fresh (no old payments).`);
  console.log(`Admin login -> username: admin   password: ${adminPass}`);
  console.log('Family logins -> username: head mobile number, first password: same mobile number.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });

# શ્રી વિશ્વકર્મા નાંદીસણ પંચાલ સમાજ બચત મંડળ — Web App

Node.js + Express + MongoDB app to run the Bachat Mandal. Gujarati by default, with an English switch.

## Run it

```bash
npm install
npm run seed      # first time only: loads the 84 members / 25 families, year 2026-27 from Besta Varsh
npm start         # open http://localhost:3000
```

`.env` already holds your MongoDB URI. The seed prints the **admin password**. Family logins use the
**head's mobile number** as both username and first password, and must change the password on first login.

`npm run seed -- --force` wipes ALL mandal data and starts again. Only use it before real use.

## Roles

| | Admin | Family login (one per family) |
|---|---|---|
| Record ₹500 payments, late fees | ✅ | ❌ |
| Families: add, move members, change head, logins | ✅ | ❌ |
| Loans | ✅ all | 🔒 only when their family is the **borrower or one of the 2 guarantors** |
| Mandal balance, pending list, all families, rules | ✅ | admin turns each on/off in **Settings → Permissions** |
| Own family month-by-month grid, totals, own pending + fines | ✅ | ✅ |

Borrower names are never shown to other users. This is enforced on the server, not just hidden in the page.

## Rules built in (from the rule book)
- Rule 2: ₹500 per member, due 1st–10th (amount and day are editable in Settings)
- Rule 16: late fee ₹1 per ₹100 per day after the 10th, calculated automatically
- Rules 5, 10, 21: interest from the loan date on the remaining principal. A repayment clears interest first, then principal.
- Rule 11: max ₹25,000 per member. Rule 12: two different guarantors. Rule 14: a member can guarantee only one active loan.
- Rule 13: a loan with no payment for 2+ months is flagged for recovery from the guarantors
- Rules 4, 17, 18: the year-end page suggests a dividend in proportion to deposits; members who missed installments get principal only
- Rule 6: Diwali-to-Diwali year. **Year accounts → Close year** saves a summary and starts a fresh year (it is blocked while loans are active, Rule 15)
- Rule 22: record insurance collections under **Other income/expense**

## Deploy
Any Node host works (Render, Railway, a VPS). Set the same variables as `.env`, and set `COOKIE_SECURE=true` on HTTPS.
In MongoDB Atlas → Network Access, allow the server's IP.

## Already seeded the old 2025-26 year?
`npm run fresh-start -- --yes` keeps families, members and logins, deletes old payments/loans, and starts 2026-27 from Besta Varsh (10-Nov-2026).

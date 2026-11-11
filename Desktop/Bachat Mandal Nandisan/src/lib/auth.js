const { Audit } = require('../models');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.mustChangePassword && req.path !== '/change-password') return res.redirect('/change-password');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.mustChangePassword) return res.redirect('/change-password');
  if (req.session.user.role !== 'admin') return res.status(403).render('message', { title: '403', text: res.locals.t('noAccess') });
  next();
}
function flash(req, type, text) { req.session.flash = { type, text }; }
async function audit(req, action, details = '') {
  try {
    await Audit.create({ user: req.session.user?._id, username: req.session.user?.username, action, details });
  } catch (e) { console.error('audit failed', e.message); }
}
module.exports = { requireLogin, requireAdmin, flash, audit };

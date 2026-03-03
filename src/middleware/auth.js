function requireAdmin(req, res, next) {
  if (!req.session || !req.session.adminUser) {
    return res.redirect('/admin666/login');
  }
  return next();
}

module.exports = { requireAdmin };

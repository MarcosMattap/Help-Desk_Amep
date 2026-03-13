function ensureAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  return res.redirect("/login");
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).send("Acesso negado.");
    }
    next();
  };
}

module.exports = {
  ensureAuthenticated,
  requireRole,
};

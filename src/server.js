const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const csrf = require("csurf");
const db = require("./db");
const { getNowBrazilTime } = require("./db");
const { ensureAuthenticated, requireRole } = require("./middlewares/auth");
const {
  isValidTicketStatus,
  isValidTicketPriority,
} = require("./constants/tickets");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret =
  process.env.SESSION_SECRET ||
  (isProduction ? null : "dev-insecure-session-secret-change-me");

if (!sessionSecret) {
  throw new Error("SESSION_SECRET nao definido. Configure a variavel de ambiente em producao.");
}

if (isProduction) {
  // Necessario para cookies secure quando app fica atras de proxy.
  app.set("trust proxy", 1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    name: "helpdesk.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

const csrfProtection = csrf();
app.use(csrfProtection);

// deixa currentUser sempre disponível nas views
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.csrfToken = req.csrfToken();
  next();
});

function isMasterAdmin(user) {
  return !!(user && user.role === "admin" && user.operadora_id === null);
}

function isMarcosPereira(user) {
  if (!user || user.role !== "admin") {
    return false;
  }

  const normalize = (value) => String(value || "").trim().toLowerCase();
  const name = normalize(user.name);
  const email = normalize(user.email);

  return name === "marcos pereira" || email.includes("marcos.pereira");
}

function isMarcosPereiraAdmin(user) {
  if (!isMasterAdmin(user) || !isMarcosPereira(user)) {
    return false;
  }

  return true;
}

function normalizeDbConsoleScope(value) {
  return value === "operadora" ? "operadora" : "amep";
}

function parseOptionalPositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function getAmepOperadoraId(operadoras) {
  const safeOperadoras = Array.isArray(operadoras) ? operadoras : [];
  const amep = safeOperadoras.find((item) => String(item.name || "").trim().toUpperCase() === "AMEP");
  return amep ? amep.id : null;
}

function getOperadoraUnidadeId(operadoras) {
  const safeOperadoras = Array.isArray(operadoras) ? operadoras : [];
  const operadora = safeOperadoras.find(
    (item) => String(item.name || "").trim().toUpperCase() === "OPERADORA"
  );
  return operadora ? operadora.id : null;
}

function requireMasterAdmin(req, res, next) {
  if (!isMasterAdmin(req.session.user)) {
    return res.status(403).send("Acesso negado: apenas admin master.");
  }
  return next();
}

// Garante que a sessao tenha operadora_id para separar admin master de admin basico.
app.use((req, res, next) => {
  const sessionUser = req.session?.user;
  if (!sessionUser || sessionUser.operadora_id !== undefined) {
    return next();
  }

  db.get("SELECT operadora_id FROM users WHERE id = ?", [sessionUser.id], (err, row) => {
    if (!err && row) {
      req.session.user.operadora_id = row.operadora_id;
      res.locals.currentUser = req.session.user;
    }
    return next();
  });
});

function writeAdminAuditLog(req, action, entityType, entityId, details) {
  const adminUserId = req?.session?.user?.id;
  if (!adminUserId) return;

  db.run(
    "INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [adminUserId, action, entityType, entityId || null, details || null, getNowBrazilTime()],
    (err) => {
      if (err) {
        console.error("Erro ao gravar log de auditoria admin:", err);
      }
    }
  );
}

function getOperadoraDbViewConfig(tableName) {
  const configs = {
    tickets: {
      label: "Chamados",
      sql:
        "SELECT t.id, t.title, t.status, t.priority, t.created_at, t.updated_at, " +
        "u.name AS requester_name, a.name AS assignee_name " +
        "FROM tickets t " +
        "JOIN users u ON u.id = t.requester_id " +
        "LEFT JOIN users a ON a.id = t.assignee_id " +
        "WHERE u.operadora_id = ? " +
        "ORDER BY t.id DESC LIMIT ?",
    },
    ticket_comments: {
      label: "Comentarios",
      sql:
        "SELECT c.id, c.ticket_id, c.user_id, u.name AS user_name, c.comment, c.created_at " +
        "FROM ticket_comments c " +
        "JOIN tickets t ON t.id = c.ticket_id " +
        "JOIN users r ON r.id = t.requester_id " +
        "JOIN users u ON u.id = c.user_id " +
        "WHERE r.operadora_id = ? " +
        "ORDER BY c.id DESC LIMIT ?",
    },
    users: {
      label: "Usuarios",
      sql:
        "SELECT id, name, email, role " +
        "FROM users " +
        "WHERE operadora_id = ? " +
        "ORDER BY id DESC LIMIT ?",
    },
    departments: {
      label: "Setores",
      sql:
        "SELECT id, name " +
        "FROM departments " +
        "WHERE operadora_id = ? " +
        "ORDER BY id DESC LIMIT ?",
    },
    categories: {
      label: "Categorias",
      sql:
        "SELECT id, name, default_priority " +
        "FROM categories " +
        "WHERE operadora_id = ? " +
        "ORDER BY id DESC LIMIT ?",
    },
  };

  return configs[tableName] || configs.tickets;
}

app.get("/", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  res.redirect("/tickets");
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/tickets");
  }
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
    if (err) {
      console.error(err);
      return res.render("login", { error: "Erro ao autenticar. Tente novamente." });
    }
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render("login", { error: "E-mail ou senha inválidos." });
    }
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      operadora_id: user.operadora_id ?? null,
    };
    res.redirect("/tickets");
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/tickets", ensureAuthenticated, (req, res) => {
  const user = req.session.user;
  let query =
    "SELECT t.*, u.name AS requester_name, a.name AS assignee_name FROM tickets t " +
    "JOIN users u ON t.requester_id = u.id " +
    "LEFT JOIN users a ON t.assignee_id = a.id ";
  const params = [];

  if (user.role === "user") {
    query += "WHERE t.requester_id = ? ";
    params.push(user.id);
  } else if (user.role === "agent") {
    // Fila do agente: exibe apenas chamados atribuidos a ele no escopo da operadora.
    query += "WHERE u.operadora_id = ? AND t.assignee_id = ? ";
    params.push(user.operadora_id, user.id);
  } else if (user.operadora_id) {
    query += "WHERE u.operadora_id = ? ";
    params.push(user.operadora_id);
  }

  query +=
    "ORDER BY CASE WHEN t.status = 'aberto' THEN 0 ELSE 1 END, " +
    "CASE WHEN t.status = 'aberto' THEN (strftime('%s', t.created_at) + 172800 + COALESCE(t.sla_paused_seconds, 0)) END ASC, " +
    "CASE t.status " +
    "  WHEN 'em_andamento' THEN 1 WHEN 'pausa' THEN 2 WHEN 'aguardando_usuario' THEN 3 " +
    "  WHEN 'resolvido' THEN 4 WHEN 'fechado' THEN 5 ELSE 6 END, " +
    "t.updated_at DESC";

  db.all(query, params, (err, tickets) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Erro ao carregar chamados.");
    }
    res.render("tickets-list", { tickets, user });
  });
});

app.get("/tickets/new", ensureAuthenticated, (req, res) => {
  const currentUser = req.session.user;
  const scopeClause = currentUser.operadora_id
    ? "(operadora_id = ? OR operadora_id IS NULL)"
    : "(operadora_id IS NULL OR operadora_id = (SELECT id FROM operadoras WHERE UPPER(TRIM(name)) = 'AMEP' LIMIT 1))";
  const scopeParams = currentUser.operadora_id ? [currentUser.operadora_id] : [];

  db.all(`SELECT * FROM departments WHERE ${scopeClause} ORDER BY name`, scopeParams, (err, departments) => {
    if (err) return res.status(500).send("Erro ao carregar setores.");
    db.all(`SELECT * FROM categories WHERE ${scopeClause} ORDER BY name`, scopeParams, (err2, categories) => {
      if (err2) return res.status(500).send("Erro ao carregar categorias.");
      res.render("ticket-new", { departments, categories });
    });
  });
});

app.post("/tickets", ensureAuthenticated, (req, res) => {
  const { title, description, department_id, category_id, priority } = req.body;
  const currentUser = req.session.user;
  const requesterId = currentUser.id;
  const safeDepartmentId = department_id && Number.isInteger(Number(department_id)) ? Number(department_id) : null;
  const normalizedPriority = isValidTicketPriority(priority) ? priority : "media";
  const safeCategoryId = category_id && Number.isInteger(Number(category_id)) ? Number(category_id) : null;
  const scopeClause = currentUser.operadora_id
    ? "(operadora_id = ? OR operadora_id IS NULL)"
    : "(operadora_id IS NULL OR operadora_id = (SELECT id FROM operadoras WHERE UPPER(TRIM(name)) = 'AMEP' LIMIT 1))";
  const scopeParams = currentUser.operadora_id ? [currentUser.operadora_id] : [];

  if (!title || !description) {
    return res.status(400).send("Titulo e descricao sao obrigatorios.");
  }

  const insertTicket = (priorityToUse) => {
    const nowTime = getNowBrazilTime();
    const sql = `
      INSERT INTO tickets (title, description, requester_id, department_id, category_id, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(
      sql,
      [
        title,
        description,
        requesterId,
        safeDepartmentId,
        safeCategoryId,
        priorityToUse,
        nowTime,
        nowTime,
      ],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).send("Erro ao abrir chamado.");
        }
        res.redirect("/tickets");
      }
    );
  };

  if (!safeCategoryId) {
    if (!safeDepartmentId) {
      return insertTicket(normalizedPriority);
    }

    return db.get(
      `SELECT id FROM departments WHERE id = ? AND ${scopeClause}`,
      [safeDepartmentId, ...scopeParams],
      (departmentErr, departmentRow) => {
        if (departmentErr) {
          console.error(departmentErr);
          return res.status(500).send("Erro ao validar setor.");
        }
        if (!departmentRow) {
          return res.status(400).send("Setor invalido para sua operadora.");
        }
        return insertTicket(normalizedPriority);
      }
    );
  }

  const validateCategory = () => {
    db.get(
      `SELECT default_priority FROM categories WHERE id = ? AND ${scopeClause}`,
      [safeCategoryId, ...scopeParams],
      (categoryErr, categoryRow) => {
        if (categoryErr) {
          console.error(categoryErr);
          return res.status(500).send("Erro ao validar categoria.");
        }
        if (!categoryRow) {
          return res.status(400).send("Categoria invalida para sua operadora.");
        }

        const categoryPriority = isValidTicketPriority(categoryRow.default_priority)
          ? categoryRow.default_priority
          : normalizedPriority;

        return insertTicket(categoryPriority);
      }
    );
  };

  if (!safeDepartmentId) {
    return validateCategory();
  }

  return db.get(
    `SELECT id FROM departments WHERE id = ? AND ${scopeClause}`,
    [safeDepartmentId, ...scopeParams],
    (departmentErr, departmentRow) => {
      if (departmentErr) {
        console.error(departmentErr);
        return res.status(500).send("Erro ao validar setor.");
      }
      if (!departmentRow) {
        return res.status(400).send("Setor invalido para sua operadora.");
      }
      return validateCategory();
    }
  );
});

app.post("/admin/categories", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const name = (req.body.name || "").trim();
  const safeDefaultPriority = isValidTicketPriority(req.body.default_priority)
    ? req.body.default_priority
    : "media";
  if (!name) return res.status(400).send("Nome da categoria e obrigatorio.");
  db.run(
    "INSERT INTO categories (name, default_priority, operadora_id) VALUES (?, ?, NULL)",
    [name, safeDefaultPriority],
    function onCreateCategory(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao criar categoria.");
      }
      writeAdminAuditLog(
        req,
        "CREATE",
        "category",
        this.lastID,
        `Categoria '${name}' criada com prioridade padrao '${safeDefaultPriority}'.`
      );
      res.redirect("/admin");
    }
  );
});

app.get("/tickets/:id", ensureAuthenticated, (req, res) => {
  const ticketId = req.params.id;
  const currentUser = req.session.user;
  const ticketSql =
    "SELECT t.*, u.name AS requester_name, a.name AS assignee_name, d.name AS department_name, c.name AS category_name, " +
    "u.operadora_id AS requester_operadora_id " +
    "FROM tickets t " +
    "JOIN users u ON t.requester_id = u.id " +
    "LEFT JOIN users a ON t.assignee_id = a.id " +
    "LEFT JOIN departments d ON t.department_id = d.id " +
    "LEFT JOIN categories c ON t.category_id = c.id " +
    "WHERE t.id = ?";

  db.get(ticketSql, [ticketId], (err, ticket) => {
    if (err || !ticket) {
      console.error(err);
      return res.status(404).send("Chamado não encontrado.");
    }

    // Evita IDOR: usuario comum so pode visualizar os proprios chamados.
    if (currentUser.role === "user" && ticket.requester_id !== currentUser.id) {
      return res.status(403).send("Acesso negado.");
    }

    // Admin/agent de operadora so pode visualizar chamados da propria operadora.
    if (currentUser.operadora_id && ticket.requester_operadora_id !== currentUser.operadora_id) {
      return res.status(403).send("Acesso negado.");
    }

    db.all(
      "SELECT c.*, u.name AS user_name FROM ticket_comments c JOIN users u ON c.user_id = u.id WHERE c.ticket_id = ? ORDER BY c.created_at ASC",
      [ticketId],
      (err2, comments) => {
        if (err2) {
          console.error(err2);
          return res.status(500).send("Erro ao carregar comentários.");
        }
        res.render("ticket-detail", { ticket, comments, user: req.session.user });
      }
    );
  });
});

app.post("/tickets/:id/comment", ensureAuthenticated, (req, res) => {
  const ticketId = req.params.id;
  const { comment } = req.body;
  const currentUser = req.session.user;
  const userId = currentUser.id;

  db.get(
    "SELECT t.requester_id, u.operadora_id AS requester_operadora_id " +
      "FROM tickets t " +
      "JOIN users u ON t.requester_id = u.id " +
      "LEFT JOIN users a ON t.assignee_id = a.id " +
      "WHERE t.id = ?",
    [ticketId],
    (ticketErr, ticket) => {
    if (ticketErr) {
      console.error(ticketErr);
      return res.status(500).send("Erro ao validar chamado.");
    }

    if (!ticket) {
      return res.status(404).send("Chamado não encontrado.");
    }

    // Evita IDOR: usuario comum so pode comentar nos proprios chamados.
    if (currentUser.role === "user" && ticket.requester_id !== currentUser.id) {
      return res.status(403).send("Acesso negado.");
    }

    // Admin/agent de operadora so pode comentar em chamados da propria operadora.
    if (currentUser.operadora_id && ticket.requester_operadora_id !== currentUser.operadora_id) {
      return res.status(403).send("Acesso negado.");
    }

    db.run(
      "INSERT INTO ticket_comments (ticket_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)",
      [ticketId, userId, comment, getNowBrazilTime()],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).send("Erro ao adicionar comentário.");
        }
        db.run(
          "UPDATE tickets SET updated_at = ? WHERE id = ?",
          [getNowBrazilTime(), ticketId],
          () => res.redirect(`/tickets/${ticketId}`)
        );
      }
    );
    }
  );
});

app.post("/tickets/:id/status", ensureAuthenticated, requireRole(["agent", "admin"]), (req, res) => {
  const ticketId = req.params.id;
  const { status } = req.body;
  const currentUser = req.session.user;
  const assigneeId = currentUser.id;
  const isResolvedStatus = status === "resolvido" || status === "fechado";
  const nowTime = getNowBrazilTime();
  const resolvedTime = isResolvedStatus ? nowTime : null;

  if (!isValidTicketStatus(status)) {
    return res.status(400).send("Status invalido.");
  }

  const runStatusUpdate = () => {
    db.run(
      "UPDATE tickets SET status = ?, assignee_id = ?, updated_at = ?, resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, ?) ELSE NULL END, sla_paused_seconds = CASE WHEN NULLIF(sla_paused_at, '') IS NOT NULL AND ? <> 'pausa' THEN COALESCE(sla_paused_seconds, 0) + COALESCE(MAX(0, CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', NULLIF(sla_paused_at, '')) AS INTEGER)), 0) ELSE COALESCE(sla_paused_seconds, 0) END, sla_paused_at = CASE WHEN ? = 'pausa' THEN COALESCE(NULLIF(sla_paused_at, ''), ?) WHEN NULLIF(sla_paused_at, '') IS NOT NULL AND ? <> 'pausa' THEN NULL ELSE NULLIF(sla_paused_at, '') END WHERE id = ?",
      [
        status,
        assigneeId,
        nowTime,
        isResolvedStatus ? 1 : 0,
        resolvedTime,
        status,
        nowTime,
        status,
        nowTime,
        status,
        ticketId,
      ],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).send("Erro ao atualizar status.");
        }
        return res.redirect(`/tickets/${ticketId}`);
      }
    );
  };

  if (!currentUser.operadora_id) {
    return runStatusUpdate();
  }

  db.get(
    "SELECT t.id FROM tickets t " +
      "JOIN users u ON t.requester_id = u.id " +
      "LEFT JOIN users a ON t.assignee_id = a.id " +
      "WHERE t.id = ? AND (u.operadora_id = ? OR a.operadora_id = ?)",
    [ticketId, currentUser.operadora_id, currentUser.operadora_id],
    (scopeErr, row) => {
      if (scopeErr) {
        console.error(scopeErr);
        return res.status(500).send("Erro ao validar permissao do chamado.");
      }
      if (!row) {
        return res.status(403).send("Acesso negado.");
      }
      return runStatusUpdate();
    }
  );
});

app.get("/admin", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  if (!isMasterAdmin(req.session.user)) {
    return res.redirect("/operadora");
  }

  db.all("SELECT id, name, email, role, operadora_id FROM users ORDER BY name", [], (userErr, users) => {
    if (userErr) return res.status(500).send("Erro ao carregar usuários.");

    db.all("SELECT * FROM empresas ORDER BY name", [], (empErr, empresas) => {
      if (empErr) return res.status(500).send("Erro ao carregar empresas.");

      db.all(
        "SELECT op.id, op.name, op.empresa_id, em.name AS empresa_name FROM operadoras op LEFT JOIN empresas em ON op.empresa_id = em.id ORDER BY em.name, op.name",
        [],
        (opErr, operadoras) => {
          if (opErr) return res.status(500).send("Erro ao carregar operadoras.");

          db.all("SELECT * FROM departments WHERE operadora_id IS NULL ORDER BY name", [], (err, departments) => {
            if (err) return res.status(500).send("Erro ao carregar setores.");

            db.all("SELECT * FROM categories WHERE operadora_id IS NULL ORDER BY name", [], (err2, categories) => {
              if (err2) return res.status(500).send("Erro ao carregar categorias.");

              const ticketsSql =
                "SELECT t.*, u.name AS requester_name, a.name AS assignee_name, " +
                "d.name AS department_name, c.name AS category_name " +
                "FROM tickets t " +
                "JOIN users u ON t.requester_id = u.id " +
                "LEFT JOIN users a ON t.assignee_id = a.id " +
                "LEFT JOIN departments d ON t.department_id = d.id " +
                "LEFT JOIN categories c ON t.category_id = c.id " +
                "ORDER BY CASE WHEN t.status = 'aberto' THEN 0 ELSE 1 END, " +
                "CASE WHEN t.status = 'aberto' THEN (strftime('%s', t.created_at) + 172800 + COALESCE(t.sla_paused_seconds, 0)) END ASC, " +
                "CASE t.status " +
                "  WHEN 'em_andamento' THEN 1 WHEN 'pausa' THEN 2 WHEN 'aguardando_usuario' THEN 3 WHEN 'resolvido' THEN 4 ELSE 5 END, " +
                "t.updated_at DESC";

              db.all(ticketsSql, [], (err3, tickets) => {
                if (err3) return res.status(500).send("Erro ao carregar chamados.");

                const agents = users.filter((u) => u.role === "agent" || u.role === "admin");

                db.all(
                  "SELECT l.*, u.name AS admin_name FROM admin_audit_logs l JOIN users u ON u.id = l.admin_user_id ORDER BY l.created_at DESC, l.id DESC LIMIT 50",
                  [],
                  (logErr, adminLogs) => {
                    if (logErr) return res.status(500).send("Erro ao carregar log de auditoria.");

                    return res.render("admin", {
                      departments,
                      categories,
                      users,
                      tickets,
                      agents,
                      adminLogs,
                      operadoras,
                    });
                  }
                );
              });
            });
          });
        }
      );
    });
  });
});

app.post("/admin/tickets/:id/assign", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const currentUser = req.session.user;
  const ticketId = Number.isInteger(Number(req.params.id)) ? Number(req.params.id) : null;
  if (!ticketId || ticketId <= 0) {
    return res.redirect(isMasterAdmin(currentUser) ? "/admin" : "/operadora");
  }
  const { assignee_id, status } = req.body;
  const safeAssigneeId = assignee_id && assignee_id !== "" ? Number(assignee_id) : null;
  const allowedStatuses = ["aberto", "em_andamento", "pausa", "aguardando_usuario", "resolvido", "fechado"];
  const safeStatus = allowedStatuses.includes(status) ? status : null;
  const isResolvedStatus = safeStatus === "resolvido" || safeStatus === "fechado";
  const nowTime = getNowBrazilTime();
  const resolvedTime = isResolvedStatus ? nowTime : null;
  if (!safeStatus) return res.status(400).send("Status inválido.");
  const updateTicket = (redirectPath) => {
    db.run(
      "UPDATE tickets SET assignee_id = ?, status = ?, updated_at = ?, resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, ?) ELSE NULL END, sla_paused_seconds = CASE WHEN NULLIF(sla_paused_at, '') IS NOT NULL AND ? <> 'pausa' THEN COALESCE(sla_paused_seconds, 0) + COALESCE(MAX(0, CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', NULLIF(sla_paused_at, '')) AS INTEGER)), 0) ELSE COALESCE(sla_paused_seconds, 0) END, sla_paused_at = CASE WHEN ? = 'pausa' THEN COALESCE(NULLIF(sla_paused_at, ''), ?) WHEN NULLIF(sla_paused_at, '') IS NOT NULL AND ? <> 'pausa' THEN NULL ELSE NULLIF(sla_paused_at, '') END WHERE id = ?",
      [
        safeAssigneeId,
        safeStatus,
        nowTime,
        isResolvedStatus ? 1 : 0,
        resolvedTime,
        safeStatus,
        nowTime,
        safeStatus,
        nowTime,
        safeStatus,
        ticketId,
      ],
      (err) => {
        if (err) return res.status(500).send("Erro ao atualizar chamado.");
        writeAdminAuditLog(
          req,
          "UPDATE",
          "ticket",
          ticketId,
          `Chamado #${ticketId} atualizado: status='${safeStatus}', assignee_id='${safeAssigneeId || "null"}'.`
        );
        return res.redirect(redirectPath);
      }
    );
  };

  if (isMasterAdmin(currentUser)) {
    return updateTicket("/admin");
  }

  if (!currentUser.operadora_id) {
    return res.status(403).send("Acesso negado: operadora nao configurada.");
  }

  db.get(
    "SELECT t.id FROM tickets t JOIN users u ON t.requester_id = u.id WHERE t.id = ? AND u.operadora_id = ?",
    [ticketId, currentUser.operadora_id],
    (scopeErr, ticketRow) => {
      if (scopeErr) {
        console.error(scopeErr);
        return res.status(500).send("Erro ao validar permissao do chamado.");
      }
      if (!ticketRow) {
        return res.status(403).send("Acesso negado: chamado fora da sua operadora.");
      }
      return updateTicket("/operadora");
    }
  );
});

app.post("/admin/departments", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).send("Nome do setor e obrigatorio.");
  db.run("INSERT INTO departments (name, operadora_id) VALUES (?, NULL)", [name], function onCreateDepartment(err) {
    if (err) console.error(err);
    if (!err) {
      writeAdminAuditLog(req, "CREATE", "department", this.lastID, `Setor '${name}' criado.`);
    }
    res.redirect("/admin");
  });
});

app.post("/admin/departments/:id/update", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const departmentId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    return res.status(400).send("ID de setor invalido.");
  }
  if (!name) return res.status(400).send("Nome do setor e obrigatorio.");

  db.run("UPDATE departments SET name = ? WHERE id = ? AND operadora_id IS NULL", [name, departmentId], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Erro ao atualizar setor.");
    }
    writeAdminAuditLog(req, "UPDATE", "department", departmentId, `Setor #${departmentId} atualizado para '${name}'.`);
    res.redirect("/admin");
  });
});

app.post("/admin/departments/:id/delete", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const departmentId = Number(req.params.id);
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    return res.status(400).send("ID de setor invalido.");
  }

  db.get(
    "SELECT COUNT(*) as total FROM tickets WHERE department_id = ?",
    [departmentId],
    (countErr, row) => {
      if (countErr) {
        console.error(countErr);
        return res.status(500).send("Erro ao validar setor.");
      }
      if (row && row.total > 0) {
        return res
          .status(400)
          .send("Nao e possivel excluir setor vinculado a chamados.");
      }

      db.run("DELETE FROM departments WHERE id = ? AND operadora_id IS NULL", [departmentId], (deleteErr) => {
        if (deleteErr) {
          console.error(deleteErr);
          return res.status(500).send("Erro ao excluir setor.");
        }
        writeAdminAuditLog(req, "DELETE", "department", departmentId, `Setor #${departmentId} excluido.`);
        res.redirect("/admin");
      });
    }
  );
});

app.post("/admin/categories/:id/update", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const categoryId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const safeDefaultPriority = isValidTicketPriority(req.body.default_priority)
    ? req.body.default_priority
    : "media";
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).send("ID de categoria invalido.");
  }
  if (!name) return res.status(400).send("Nome da categoria e obrigatorio.");

  db.run(
    "UPDATE categories SET name = ?, default_priority = ? WHERE id = ? AND operadora_id IS NULL",
    [name, safeDefaultPriority, categoryId],
    (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Erro ao atualizar categoria.");
    }
    writeAdminAuditLog(
      req,
      "UPDATE",
      "category",
      categoryId,
      `Categoria #${categoryId} atualizada para '${name}' com prioridade padrao '${safeDefaultPriority}'.`
    );
    res.redirect("/admin");
    }
  );
});

app.post("/admin/categories/:id/delete", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const categoryId = Number(req.params.id);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).send("ID de categoria invalido.");
  }

  // Remove o vínculo da categoria nos chamados para permitir exclusão segura.
  db.run("UPDATE tickets SET category_id = NULL WHERE category_id = ?", [categoryId], (updateErr) => {
    if (updateErr) {
      console.error(updateErr);
      return res.status(500).send("Erro ao desvincular categoria dos chamados.");
    }

    db.run("DELETE FROM categories WHERE id = ? AND operadora_id IS NULL", [categoryId], (deleteErr) => {
      if (deleteErr) {
        console.error(deleteErr);
        return res.status(500).send("Erro ao excluir categoria.");
      }
      writeAdminAuditLog(req, "DELETE", "category", categoryId, `Categoria #${categoryId} excluida.`);
      res.redirect("/admin");
    });
  });
});

app.post("/admin/users", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const { name, email, password, role, operadora_id } = req.body;

  if (!name || !email || !password) {
    return res.status(400).send("Nome, e-mail e senha são obrigatórios.");
  }

  const validRoles = ["user", "agent", "admin"];
  const userRole = validRoles.includes(role) ? role : "user";
  const operadoraIdFinal = operadora_id && operadora_id !== "" ? Number(operadora_id) : null;

  const passwordHash = bcrypt.hashSync(password, 10);

  db.run(
    "INSERT INTO users (name, email, password_hash, role, operadora_id) VALUES (?, ?, ?, ?, ?)",
    [name, email, passwordHash, userRole, operadoraIdFinal],
    function onCreateUser(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao criar usuário (verifique se o e-mail já não existe).");
      }
      writeAdminAuditLog(req, "CREATE", "user", this.lastID, `Usuario '${name}' (${email}) criado com papel '${userRole}'${operadoraIdFinal ? ` na operadora ${operadoraIdFinal}` : ' (master)'}.`);
      res.redirect("/admin");
    }
  );
});

app.post("/admin/users/:id/update", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim();
  const password = (req.body.password || "").trim();
  const operadoraIdFinal = req.body.operadora_id && req.body.operadora_id !== "" ? Number(req.body.operadora_id) : null;
  const validRoles = ["user", "agent", "admin"];
  const role = validRoles.includes(req.body.role) ? req.body.role : "user";

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("ID de usuario invalido.");
  }
  if (!name || !email) {
    return res.status(400).send("Nome e e-mail sao obrigatorios.");
  }
  if (operadoraIdFinal !== null && (!Number.isInteger(operadoraIdFinal) || operadoraIdFinal <= 0)) {
    return res.status(400).send("Operadora invalida.");
  }

  db.get("SELECT id FROM users WHERE id = ?", [userId], (findErr, existingUser) => {
    if (findErr) {
      console.error(findErr);
      return res.status(500).send("Erro ao validar usuario.");
    }
    if (!existingUser) {
      return res.status(404).send("Usuario nao encontrado.");
    }

    if (!password) {
      db.run(
        "UPDATE users SET name = ?, email = ?, role = ?, operadora_id = ? WHERE id = ?",
        [name, email, role, operadoraIdFinal, userId],
        (updateErr) => {
          if (updateErr) {
            console.error(updateErr);
            return res.status(500).send("Erro ao atualizar usuario.");
          }
          writeAdminAuditLog(
            req,
            "UPDATE",
            "user",
            userId,
            `Usuario #${userId} atualizado para '${name}' (${email}) com papel '${role}'${operadoraIdFinal ? ` na operadora ${operadoraIdFinal}` : " (master)"}.`
          );
          res.redirect("/admin");
        }
      );
      return;
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    db.run(
      "UPDATE users SET name = ?, email = ?, role = ?, operadora_id = ?, password_hash = ? WHERE id = ?",
      [name, email, role, operadoraIdFinal, passwordHash, userId],
      (updateErr) => {
        if (updateErr) {
          console.error(updateErr);
          return res.status(500).send("Erro ao atualizar usuario.");
        }
        writeAdminAuditLog(
          req,
          "UPDATE",
          "user",
          userId,
          `Usuario #${userId} atualizado (incluindo senha), papel '${role}'${operadoraIdFinal ? ` na operadora ${operadoraIdFinal}` : " (master)"}.`
        );
        res.redirect("/admin");
      }
    );
  });
});

app.post("/admin/users/:id/delete", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const currentUserId = req.session.user.id;
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("ID de usuario invalido.");
  }
  if (userId === currentUserId) {
    return res.status(400).send("Nao e permitido excluir o proprio usuario logado.");
  }

  db.get("SELECT role FROM users WHERE id = ?", [userId], (userErr, userRow) => {
    if (userErr) {
      console.error(userErr);
      return res.status(500).send("Erro ao validar usuario.");
    }
    if (!userRow) {
      return res.status(404).send("Usuario nao encontrado.");
    }

    const checkAndDelete = () => {
      db.get(
        "SELECT COUNT(*) as total FROM tickets WHERE requester_id = ? OR assignee_id = ?",
        [userId, userId],
        (ticketsErr, ticketRow) => {
          if (ticketsErr) {
            console.error(ticketsErr);
            return res.status(500).send("Erro ao validar usuario.");
          }
          if (ticketRow && ticketRow.total > 0) {
            return res
              .status(400)
              .send("Nao e possivel excluir usuario vinculado a chamados.");
          }

          db.get("SELECT COUNT(*) as total FROM ticket_comments WHERE user_id = ?", [userId], (commentErr, commentRow) => {
            if (commentErr) {
              console.error(commentErr);
              return res.status(500).send("Erro ao validar usuario.");
            }
            if (commentRow && commentRow.total > 0) {
              return res
                .status(400)
                .send("Nao e possivel excluir usuario com historico de comentarios.");
            }

            db.run("DELETE FROM users WHERE id = ?", [userId], (deleteErr) => {
              if (deleteErr) {
                console.error(deleteErr);
                return res.status(500).send("Erro ao excluir usuario.");
              }
              writeAdminAuditLog(req, "DELETE", "user", userId, `Usuario #${userId} excluido.`);
              res.redirect("/admin");
            });
          });
        }
      );
    };

    if (userRow.role !== "admin") {
      return checkAndDelete();
    }

    db.get("SELECT COUNT(*) as total FROM users WHERE role = 'admin'", [], (adminErr, adminRow) => {
      if (adminErr) {
        console.error(adminErr);
        return res.status(500).send("Erro ao validar usuario admin.");
      }
      if (adminRow && adminRow.total <= 1) {
        return res.status(400).send("Nao e permitido excluir o ultimo admin do sistema.");
      }
      return checkAndDelete();
    });
  });
});

function queryAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows || []);
    });
  });
}

function queryGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

async function buildRelatorioData(operadoraId = null) {
  const whereClause = operadoraId === null ? "" : "WHERE u.operadora_id = ?";
  const params = operadoraId === null ? [] : [operadoraId];
  const normalizedCreatedAtSql =
    "CASE " +
    "WHEN t.created_at LIKE '__/__/____ __:__:__' THEN substr(t.created_at, 7, 4) || '-' || substr(t.created_at, 4, 2) || '-' || substr(t.created_at, 1, 2) || substr(t.created_at, 11) " +
    "ELSE t.created_at END";
  const weekdayExpr = `strftime('%w', ${normalizedCreatedAtSql})`;
  const monthExpr = `strftime('%Y-%m', ${normalizedCreatedAtSql})`;

  const sqlStatus =
    "SELECT t.status, COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id " +
    `${whereClause} GROUP BY t.status`;
  const sqlPriority =
    "SELECT t.priority, COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id " +
    `${whereClause} GROUP BY t.priority`;
  const sqlTopWeekday =
    `SELECT ${weekdayExpr} as weekday, COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id ` +
    `${whereClause} GROUP BY weekday HAVING weekday IS NOT NULL ORDER BY total DESC, weekday ASC LIMIT 1`;
  const sqlWeekdayData =
    `SELECT ${weekdayExpr} as weekday, COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id ` +
    `${whereClause} GROUP BY weekday HAVING weekday IS NOT NULL ORDER BY weekday ASC`;
  const sqlMonthly =
    `SELECT ${monthExpr} as mes, COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id ` +
    `${whereClause}${operadoraId === null ? " WHERE" : " AND"} ${monthExpr} IS NOT NULL AND date(${normalizedCreatedAtSql}) >= date('now', '-6 months') ` +
    "GROUP BY mes ORDER BY mes ASC";
  const sqlAvgTime =
    "SELECT ROUND(AVG((((julianday(t.resolved_at) - julianday(t.created_at)) * 86400) - COALESCE(t.sla_paused_seconds, 0)) / 3600.0), 1) AS media_horas FROM tickets t JOIN users u ON u.id = t.requester_id " +
    `${whereClause}${operadoraId === null ? " WHERE" : " AND"} t.resolved_at IS NOT NULL`;
  const sqlCategories =
    "SELECT c.name, COUNT(t.id) as total FROM tickets t JOIN users u ON t.requester_id = u.id LEFT JOIN categories c ON t.category_id = c.id " +
    `${whereClause} GROUP BY t.category_id ORDER BY total DESC LIMIT 5`;
  const sqlAgents =
    "SELECT a.name, COUNT(t.id) as total FROM tickets t JOIN users r ON r.id = t.requester_id JOIN users a ON t.assignee_id = a.id " +
    `${operadoraId === null ? "" : "WHERE r.operadora_id = ? "}GROUP BY t.assignee_id ORDER BY total DESC LIMIT 8`;
  const sqlSectors =
    "SELECT COALESCE(d.name, 'Sem setor') AS setor, COUNT(t.id) as total FROM tickets t JOIN users u ON t.requester_id = u.id LEFT JOIN departments d ON t.department_id = d.id " +
    `${whereClause} GROUP BY setor ORDER BY total DESC`;
  const sqlSectorWeekdays =
    `SELECT COALESCE(d.name, 'Sem setor') AS setor, ${weekdayExpr} as weekday, COUNT(t.id) as total FROM tickets t JOIN users u ON t.requester_id = u.id LEFT JOIN departments d ON t.department_id = d.id ` +
    `${whereClause} GROUP BY setor, weekday HAVING weekday IS NOT NULL ORDER BY setor ASC, weekday ASC`;
  const sqlTotal =
    "SELECT COUNT(*) as total FROM tickets t JOIN users u ON u.id = t.requester_id " +
    whereClause;

  const agentParams = operadoraId === null ? [] : [operadoraId];

  const [
    statusData,
    priorityData,
    topWeekday,
    weekdayData,
    monthlyData,
    avgTime,
    categoriesData,
    agentsData,
    sectorsData,
    sectorWeekdaysData,
    totalRow,
  ] = await Promise.all([
    queryAll(sqlStatus, params),
    queryAll(sqlPriority, params),
    queryGet(sqlTopWeekday, params),
    queryAll(sqlWeekdayData, params),
    queryAll(sqlMonthly, params),
    queryGet(sqlAvgTime, params),
    queryAll(sqlCategories, params),
    queryAll(sqlAgents, agentParams),
    queryAll(sqlSectors, params),
    queryAll(sqlSectorWeekdays, params),
    queryGet(sqlTotal, params),
  ]);

  return {
    statusData,
    priorityData,
    topWeekday,
    weekdayData,
    monthlyData,
    avgTime: avgTime ? avgTime.media_horas : null,
    categoriesData,
    agentsData,
    sectorsData,
    sectorWeekdaysData,
    totalTickets: totalRow ? totalRow.total : 0,
  };
}

app.get("/admin/relatorios", ensureAuthenticated, requireMasterAdmin, async (req, res) => {
  try {
    const data = await buildRelatorioData(null);
    return res.render("admin-relatorios", data);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Erro ao carregar dados.");
  }
});

async function renderOperadoraRelatorios(res, operadoraId) {
  try {
    const data = await buildRelatorioData(operadoraId);
    return res.render("admin-relatorios", data);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Erro ao carregar dados.");
  }
}

app.get("/operadora/relatorios", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  if (!user.operadora_id) {
    return res.redirect("/admin/relatorios");
  }
  return renderOperadoraRelatorios(res, user.operadora_id);
});

app.get("/operadora/:id/relatorios", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const operadoraId = Number(req.params.id);

  if (!Number.isInteger(operadoraId) || operadoraId <= 0) {
    return res.status(400).send("ID de operadora invalido.");
  }
  if (user.operadora_id && user.operadora_id !== operadoraId) {
    return res.status(403).send("Acesso negado: voce so pode acessar relatorios da sua operadora.");
  }
  if (!user.operadora_id) {
    return res.redirect("/admin/relatorios");
  }
  return renderOperadoraRelatorios(res, operadoraId);
});

app.get("/admin/db-console", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  if (!isMarcosPereiraAdmin(req.session.user)) {
    return res.status(403).send("Acesso negado: console de banco disponivel apenas para Marcos Pereira.");
  }

  const queryError = req.query.error;
  const querySuccess = req.query.success;
  const deletedFlag = req.query.deleted;
  const selectedScope = normalizeDbConsoleScope(req.query.scope);

  const uiError = queryError === "csrf"
    ? "Sua sessao expirou e o token de seguranca foi renovado. Tente executar o SQL novamente."
    : null;
  const uiSuccess = querySuccess === "deleted" || deletedFlag === "ticket"
    ? "Chamado excluido com sucesso."
    : null;

  db.all(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [],
    (tablesErr, tables) => {
      if (tablesErr) {
        console.error(tablesErr);
        return res.status(500).send("Erro ao carregar tabelas do banco.");
      }

      db.all("SELECT id, name FROM operadoras ORDER BY name", [], (opsErr, operadoras) => {
        if (opsErr) {
          console.error(opsErr);
          return res.status(500).send("Erro ao carregar operadoras para o console.");
        }

        const safeOperadoras = Array.isArray(operadoras) ? operadoras : [];
        const amepOperadoraId = getAmepOperadoraId(safeOperadoras);
        const operadoraUnidadeId = getOperadoraUnidadeId(safeOperadoras);

        return res.render("admin-db-console", {
          sql: "",
          result: null,
          error: uiError,
          success: uiSuccess,
          tables: Array.isArray(tables) ? tables.map((item) => item.name) : [],
          selectedScope,
          amepOperadoraId,
          operadoraUnidadeId,
        });
      });
    }
  );
});

app.post("/admin/db-console", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  if (!isMarcosPereiraAdmin(req.session.user)) {
    return res.status(403).send("Acesso negado: console de banco disponivel apenas para Marcos Pereira.");
  }

  const sql = String(req.body.sql || "").trim();
  const selectedScope = normalizeDbConsoleScope(req.body.scope);

  const renderWithContext = (payload) => {
    db.all(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
      (tablesErr, tables) => {
        if (tablesErr) {
          console.error(tablesErr);
          return res.status(500).send("Erro ao carregar tabelas do banco.");
        }

        db.all("SELECT id, name FROM operadoras ORDER BY name", [], (opsErr, operadoras) => {
          if (opsErr) {
            console.error(opsErr);
            return res.status(500).send("Erro ao carregar operadoras para o console.");
          }

          const safeOperadoras = Array.isArray(operadoras) ? operadoras : [];
          const amepOperadoraId = getAmepOperadoraId(safeOperadoras);
          const operadoraUnidadeId = getOperadoraUnidadeId(safeOperadoras);

          return res.render("admin-db-console", {
            sql,
            result: payload.result || null,
            error: payload.error || null,
            success: payload.success || null,
            tables: Array.isArray(tables) ? tables.map((item) => item.name) : [],
            selectedScope,
            amepOperadoraId,
            operadoraUnidadeId,
          });
        });
      }
    );
  };

  if (!sql) {
    return renderWithContext({
      error: "Digite uma consulta SQL para executar.",
    });
  }

  // Remove BOM, espacos e comentarios iniciais para detectar corretamente o tipo da consulta.
  const stripLeadingSqlComments = (input) => {
    let text = String(input || "").replace(/^\uFEFF/, "");
    let changed = true;

    while (changed) {
      changed = false;

      const beforeTrim = text;
      text = text.replace(/^\s+/, "");
      if (text !== beforeTrim) {
        changed = true;
      }

      const beforeLineComment = text;
      text = text.replace(/^--[^\n]*(\n|$)/, "");
      if (text !== beforeLineComment) {
        changed = true;
      }

      const beforeBlockComment = text;
      text = text.replace(/^\/\*[\s\S]*?\*\//, "");
      if (text !== beforeBlockComment) {
        changed = true;
      }
    }

    return text;
  };

  const normalizedSql = stripLeadingSqlComments(sql);
  const firstTokenMatch = normalizedSql.match(/^([a-zA-Z]+)/);
  const firstToken = firstTokenMatch ? firstTokenMatch[1].toUpperCase() : "";
  const isReadQuery = ["SELECT", "WITH", "PRAGMA", "EXPLAIN"].includes(firstToken);

  if (isReadQuery) {
    return db.all(sql, [], (queryErr, rows) => {
      if (queryErr) {
        console.error(queryErr);
        return renderWithContext({
          error: `Erro SQL: ${queryErr.message}`,
        });
      }

      return renderWithContext({
        result: {
          mode: "read",
          rows: Array.isArray(rows) ? rows : [],
          rowCount: Array.isArray(rows) ? rows.length : 0,
        },
        success: "Consulta executada com sucesso.",
      });
    });
  }

  return db.run(sql, [], function executeMutation(runErr) {
    if (runErr) {
      console.error(runErr);
      return renderWithContext({
        error: `Erro SQL: ${runErr.message}`,
      });
    }

    writeAdminAuditLog(
      req,
      "DB_CONSOLE",
      "database",
      null,
      `SQL executado por console: ${sql.slice(0, 500)}`
    );

    return renderWithContext({
      result: {
        mode: "write",
        changes: typeof this.changes === "number" ? this.changes : 0,
        lastID: typeof this.lastID === "number" ? this.lastID : null,
      },
      success: "Comando executado com sucesso.",
    });
  });
});

app.post("/admin/db-console/delete-ticket", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  if (!isMarcosPereiraAdmin(req.session.user)) {
    return res.status(403).send("Acesso negado: console de banco disponivel apenas para Marcos Pereira.");
  }

  const ticketId = Number(req.body.ticket_id);
  const selectedScope = normalizeDbConsoleScope(req.body.scope);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    return res.status(400).send("ID de chamado invalido.");
  }

  db.all("SELECT id, name FROM operadoras", [], (opsErr, operadoras) => {
    if (opsErr) {
      console.error(opsErr);
      return res.status(500).send("Erro ao carregar operadoras para validacao do escopo.");
    }

    const amepOperadoraId = getAmepOperadoraId(operadoras);
    const operadoraUnidadeId = getOperadoraUnidadeId(operadoras);
    if (selectedScope === "operadora" && !operadoraUnidadeId) {
      return res.status(400).send("Unidade 'Operadora' nao encontrada para esse escopo.");
    }
    const ticketScopeSql =
      selectedScope === "operadora"
        ? "SELECT t.id, t.title FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.id = ? AND u.operadora_id = ?"
        : (amepOperadoraId
          ? "SELECT t.id, t.title FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.id = ? AND (u.operadora_id = ? OR u.operadora_id IS NULL)"
          : "SELECT t.id, t.title FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.id = ? AND u.operadora_id IS NULL");

    const ticketScopeParams = selectedScope === "operadora"
      ? [ticketId, operadoraUnidadeId]
      : (amepOperadoraId ? [ticketId, amepOperadoraId] : [ticketId]);

    db.get(ticketScopeSql, ticketScopeParams, (findErr, ticket) => {
    if (findErr) {
      console.error(findErr);
      return res.status(500).send("Erro ao localizar chamado para exclusao.");
    }

    if (!ticket) {
      return res.status(404).send("Chamado nao encontrado.");
    }

    db.serialize(() => {
      db.run("BEGIN TRANSACTION");

      db.run("DELETE FROM ticket_comments WHERE ticket_id = ?", [ticketId], (deleteCommentsErr) => {
        if (deleteCommentsErr) {
          console.error(deleteCommentsErr);
          return db.run("ROLLBACK", () => res.status(500).send("Erro ao excluir comentarios do chamado."));
        }

        db.run("DELETE FROM tickets WHERE id = ?", [ticketId], function deleteTicket(deleteTicketErr) {
          if (deleteTicketErr) {
            console.error(deleteTicketErr);
            return db.run("ROLLBACK", () => res.status(500).send("Erro ao excluir chamado."));
          }

          if (this.changes === 0) {
            return db.run("ROLLBACK", () => res.status(404).send("Chamado nao encontrado para exclusao."));
          }

          db.run("COMMIT", (commitErr) => {
            if (commitErr) {
              console.error(commitErr);
              return db.run("ROLLBACK", () => res.status(500).send("Erro ao finalizar exclusao do chamado."));
            }

            writeAdminAuditLog(
              req,
              "DELETE",
              "ticket",
              ticketId,
              `Chamado #${ticketId} ('${ticket.title}') excluido pelo console de banco.`
            );

            const queryParams = new URLSearchParams({
              success: "deleted",
              scope: selectedScope,
            });
            return res.redirect(`/admin/db-console?${queryParams.toString()}`);
          });
        });
      });
    });
  });
  });
});

// Minha conta - visualizar dados
app.get("/account", ensureAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  db.get("SELECT id, name, email, role FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) {
      console.error(err);
      return res.status(500).send("Erro ao carregar dados do usuário.");
    }
    res.render("account", { user, error: null, success: null });
  });
});

// Minha conta - atualizar nome, e-mail e senha
app.post("/account", ensureAuthenticated, (req, res) => {
  const userId = req.session.user.id;
  const { name, email, current_password, new_password, confirm_password } = req.body;

  db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) {
      console.error(err);
      return res.status(500).send("Erro ao carregar dados do usuário.");
    }

    let error = null;
    let success = null;

    if (!name || !email) {
      error = "Nome e e-mail são obrigatórios.";
      return res.render("account", { user, error, success });
    }

    const wantsPasswordChange = new_password || confirm_password || current_password;

    if (wantsPasswordChange) {
      if (!current_password || !new_password || !confirm_password) {
        error = "Para alterar a senha, preencha todos os campos de senha.";
        return res.render("account", { user, error, success });
      }

      if (!bcrypt.compareSync(current_password, user.password_hash)) {
        error = "Senha atual incorreta.";
        return res.render("account", { user, error, success });
      }

      if (new_password !== confirm_password) {
        error = "A nova senha e a confirmação não conferem.";
        return res.render("account", { user, error, success });
      }
    }

    const updateUser = (passwordHash = null) => {
      const sql =
        passwordHash !== null
          ? "UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?"
          : "UPDATE users SET name = ?, email = ? WHERE id = ?";

      const params =
        passwordHash !== null ? [name, email, passwordHash, userId] : [name, email, userId];

      db.run(sql, params, function (updateErr) {
        if (updateErr) {
          if (updateErr.code === "SQLITE_CONSTRAINT") {
            error = "Já existe um usuário com esse e-mail.";
          } else {
            console.error(updateErr);
            error = "Erro ao atualizar dados.";
          }
          return res.render("account", { user, error, success });
        }

        // atualizar sessão
        req.session.user.name = name;
        req.session.user.email = email;

        success = "Dados atualizados com sucesso.";
        const updatedUser = { ...user, name, email };
        return res.render("account", { user: updatedUser, error, success });
      });
    };

    if (wantsPasswordChange) {
      const passwordHash = bcrypt.hashSync(new_password, 10);
      updateUser(passwordHash);
    } else {
      updateUser();
    }
  });
});

// ===== Gerenciamento de Operadoras =====
app.get("/admin/operadoras", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  db.all(
    `SELECT op.id, op.name, op.empresa_id, em.name AS empresa_name
     FROM operadoras op
     LEFT JOIN empresas em ON op.empresa_id = em.id
     ORDER BY em.name, op.name`,
    [],
    (err, operadoras) => {
      if (err) return res.status(500).send("Erro ao carregar operadoras.");
      db.all("SELECT * FROM empresas ORDER BY name", [], (empErr, empresas) => {
        if (empErr) return res.status(500).send("Erro ao carregar empresas.");
        res.render("admin-operadoras", { operadoras, empresas });
      });
    }
  );
});

app.post("/admin/empresas", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const name = (req.body.name || "").trim();

  if (!name) {
    return res.status(400).send("Nome da empresa é obrigatório.");
  }

  db.run(
    "INSERT INTO empresas (name, created_at) VALUES (?, ?)",
    [name, getNowBrazilTime()],
    function onCreateEmpresa(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao criar empresa (verifique se o nome já existe).");
      }
      writeAdminAuditLog(req, "CREATE", "empresa", this.lastID, `Empresa '${name}' criada.`);
      return res.redirect("/admin/operadoras");
    }
  );
});

app.post("/admin/operadoras", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const name = (req.body.name || "").trim();
  const empresaId = Number(req.body.empresa_id);

  if (!name) {
    return res.status(400).send("Nome da operadora é obrigatório.");
  }

  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    return res.status(400).send("Empresa inválida.");
  }

  db.get("SELECT id FROM empresas WHERE id = ?", [empresaId], (empErr, empresa) => {
    if (empErr) {
      console.error(empErr);
      return res.status(500).send("Erro ao validar empresa.");
    }
    if (!empresa) {
      return res.status(404).send("Empresa não encontrada.");
    }

    db.run(
      "INSERT INTO operadoras (name, empresa_id, created_at) VALUES (?, ?, ?)",
      [name, empresaId, getNowBrazilTime()],
      function onCreateOperadora(err) {
        if (err) {
          console.error(err);
          return res.status(500).send("Erro ao criar operadora (verifique se o nome já existe).");
        }
        writeAdminAuditLog(req, "CREATE", "operadora", this.lastID, `Operadora '${name}' criada.`);
        res.redirect("/admin/operadoras");
      }
    );
  });
});

app.post("/admin/operadoras/:id/delete", ensureAuthenticated, requireMasterAdmin, (req, res) => {
  const operadoraId = Number(req.params.id);

  if (!Number.isInteger(operadoraId) || operadoraId <= 0) {
    return res.status(400).send("ID de operadora inválido.");
  }

  db.run("DELETE FROM operadoras WHERE id = ?", [operadoraId], function onDeleteOperadora(err) {
    if (err) {
      console.error(err);
      return res.status(500).send("Erro ao excluir operadora.");
    }
    writeAdminAuditLog(req, "DELETE", "operadora", operadoraId, "Operadora excluída.");
    res.redirect("/admin/operadoras");
  });
});

// ===== Tela do Admin da Operadora (com ID para super admin) =====
app.get("/operadora/:id", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const operadoraId = Number(req.params.id);

  if (!Number.isInteger(operadoraId) || operadoraId <= 0) {
    return res.status(400).send("ID de operadora inválido.");
  }

  // Se é um super admin (sem operadora_id), permite acessar qualquer uma
  if (user.operadora_id && user.operadora_id !== operadoraId) {
    return res.status(403).send("Acesso negado: você só pode acessar sua operadora.");
  }

  // Carrega dados específicos da operadora
  db.get("SELECT * FROM operadoras WHERE id = ?", [operadoraId], (opErr, operadora) => {
    if (opErr || !operadora) {
      return res.status(404).send("Operadora não encontrada.");
    }

    db.all(
      "SELECT id, name, email, role FROM users WHERE operadora_id = ? ORDER BY name",
      [operadoraId],
      (userErr, users) => {
        if (userErr) return res.status(500).send("Erro ao carregar usuários.");
        
        db.all(
          "SELECT t.*, u.name AS requester_name, a.name AS assignee_name FROM tickets t " +
          "JOIN users u ON t.requester_id = u.id " +
          "LEFT JOIN users a ON t.assignee_id = a.id " +
          "WHERE u.operadora_id = ? " +
          "ORDER BY CASE WHEN t.status = 'aberto' THEN 0 ELSE 1 END, " +
          "CASE WHEN t.status = 'aberto' THEN (strftime('%s', t.created_at) + 172800 + COALESCE(t.sla_paused_seconds, 0)) END ASC, " +
          "CASE t.status " +
          "  WHEN 'em_andamento' THEN 1 WHEN 'pausa' THEN 2 WHEN 'aguardando_usuario' THEN 3 WHEN 'resolvido' THEN 4 ELSE 5 END, " +
          "t.updated_at DESC",
          [operadoraId],
          (tickErr, tickets) => {
            if (tickErr) return res.status(500).send("Erro ao carregar chamados.");

            db.all("SELECT * FROM departments WHERE operadora_id = ? ORDER BY name", [operadoraId], (depErr, departments) => {
              if (depErr) return res.status(500).send("Erro ao carregar setores.");

              db.all("SELECT * FROM categories WHERE operadora_id = ? ORDER BY name", [operadoraId], (catErr, categories) => {
                if (catErr) return res.status(500).send("Erro ao carregar categorias.");

                const agents = users.filter((u) => u.role === "agent" || u.role === "admin");

                res.render("admin-operadora", {
                  operadora,
                  users,
                  tickets,
                  agents,
                  departments,
                  categories,
                  canManageOperadora: true,
                });
              });
            });
          }
        );
      }
    );
  });
});

// ===== Tela do Admin da Operadora =====
app.get("/operadora", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  
  // Se é um super admin sem operadora, redireciona para lista de operadoras
  if (!user.operadora_id) {
    return res.redirect("/admin/operadoras");
  }

  // Carrega dados específicos da operadora
  db.get("SELECT * FROM operadoras WHERE id = ?", [user.operadora_id], (opErr, operadora) => {
    if (opErr || !operadora) {
      return res.status(404).send("Operadora não encontrada.");
    }

    db.all(
      "SELECT id, name, email, role FROM users WHERE operadora_id = ? ORDER BY name",
      [user.operadora_id],
      (userErr, users) => {
        if (userErr) return res.status(500).send("Erro ao carregar usuários.");
        
        db.all(
          "SELECT t.*, u.name AS requester_name, a.name AS assignee_name FROM tickets t " +
          "JOIN users u ON t.requester_id = u.id " +
          "LEFT JOIN users a ON t.assignee_id = a.id " +
          "WHERE u.operadora_id = ? " +
          "ORDER BY CASE WHEN t.status = 'aberto' THEN 0 ELSE 1 END, " +
          "CASE WHEN t.status = 'aberto' THEN (strftime('%s', t.created_at) + 172800 + COALESCE(t.sla_paused_seconds, 0)) END ASC, " +
          "CASE t.status " +
          "  WHEN 'em_andamento' THEN 1 WHEN 'pausa' THEN 2 WHEN 'aguardando_usuario' THEN 3 WHEN 'resolvido' THEN 4 ELSE 5 END, " +
          "t.updated_at DESC",
          [user.operadora_id],
          (tickErr, tickets) => {
            if (tickErr) return res.status(500).send("Erro ao carregar chamados.");

            db.all("SELECT * FROM departments WHERE operadora_id = ? ORDER BY name", [user.operadora_id], (depErr, departments) => {
              if (depErr) return res.status(500).send("Erro ao carregar setores.");

              db.all("SELECT * FROM categories WHERE operadora_id = ? ORDER BY name", [user.operadora_id], (catErr, categories) => {
                if (catErr) return res.status(500).send("Erro ao carregar categorias.");

                const agents = users.filter((u) => u.role === "agent" || u.role === "admin");

                res.render("admin-operadora", {
                  operadora,
                  users,
                  tickets,
                  agents,
                  departments,
                  categories,
                  canManageOperadora: true,
                });
              });
            });
          }
        );
      }
    );
  });
});

app.get("/operadora/db-view", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  if (!isMarcosPereira(user)) {
    return res.status(403).send("Acesso negado: visao de banco da operadora disponivel apenas para Marcos Pereira.");
  }
  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora nao configurada.");
  }
  return res.redirect(`/operadora/${user.operadora_id}/db-view`);
});

app.get("/operadora/:id/db-view", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  if (!isMarcosPereira(user)) {
    return res.status(403).send("Acesso negado: visao de banco da operadora disponivel apenas para Marcos Pereira.");
  }
  const operadoraId = Number(req.params.id);
  const selectedTable = String(req.query.table || "tickets").trim().toLowerCase();
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 10 && requestedLimit <= 200
    ? requestedLimit
    : 50;

  if (!Number.isInteger(operadoraId) || operadoraId <= 0) {
    return res.status(400).send("ID de operadora invalido.");
  }

  if (user.operadora_id && user.operadora_id !== operadoraId) {
    return res.status(403).send("Acesso negado: voce so pode acessar dados da sua operadora.");
  }

  const config = getOperadoraDbViewConfig(selectedTable);
  const allowedTables = [
    { key: "tickets", label: "Chamados" },
    { key: "ticket_comments", label: "Comentarios" },
    { key: "users", label: "Usuarios" },
    { key: "departments", label: "Setores" },
    { key: "categories", label: "Categorias" },
  ];

  db.get("SELECT id, name FROM operadoras WHERE id = ?", [operadoraId], (opErr, operadora) => {
    if (opErr) {
      console.error(opErr);
      return res.status(500).send("Erro ao carregar operadora.");
    }
    if (!operadora) {
      return res.status(404).send("Operadora nao encontrada.");
    }

    db.all(config.sql, [operadoraId, limit], (queryErr, rows) => {
      if (queryErr) {
        console.error(queryErr);
        return res.status(500).send("Erro ao carregar visao de banco da operadora.");
      }

      const safeRows = Array.isArray(rows) ? rows : [];
      const columns = safeRows.length > 0 ? Object.keys(safeRows[0]) : [];

      return res.render("admin-operadora-db", {
        operadora,
        selectedTable,
        selectedTableLabel: config.label,
        limit,
        rows: safeRows,
        columns,
        allowedTables,
      });
    });
  });
});

app.post("/operadora/departments", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const name = (req.body.name || "").trim();

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }
  if (!name) {
    return res.status(400).send("Nome do setor é obrigatório.");
  }

  db.run("INSERT INTO departments (name, operadora_id) VALUES (?, ?)", [name, user.operadora_id], function onCreateDepartment(err) {
    if (err) {
      console.error(err);
      return res.status(500).send("Erro ao criar setor (verifique se o nome já existe).");
    }
    writeAdminAuditLog(req, "CREATE", "department_operadora", this.lastID, `Setor '${name}' criado pela operadora.`);
    return res.redirect("/operadora");
  });
});

app.post("/operadora/categories", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const name = (req.body.name || "").trim();
  const safeDefaultPriority = isValidTicketPriority(req.body.default_priority)
    ? req.body.default_priority
    : "media";

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }
  if (!name) {
    return res.status(400).send("Nome da categoria é obrigatório.");
  }

  db.run(
    "INSERT INTO categories (name, default_priority, operadora_id) VALUES (?, ?, ?)",
    [name, safeDefaultPriority, user.operadora_id],
    function onCreateCategory(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao criar categoria (verifique se o nome já existe).");
      }
      writeAdminAuditLog(
        req,
        "CREATE",
        "category_operadora",
        this.lastID,
        `Categoria '${name}' criada pela operadora com prioridade '${safeDefaultPriority}'.`
      );
      return res.redirect("/operadora");
    }
  );
});

app.post("/operadora/departments/:id/delete", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const departmentId = Number(req.params.id);

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    return res.status(400).send("ID de setor inválido.");
  }

  db.run(
    "UPDATE tickets SET department_id = NULL WHERE department_id = ? AND requester_id IN (SELECT id FROM users WHERE operadora_id = ?)",
    [departmentId, user.operadora_id],
    (unlinkErr) => {
      if (unlinkErr) {
        console.error(unlinkErr);
        return res.status(500).send("Erro ao desvincular setor dos chamados da operadora.");
      }

      db.run("DELETE FROM departments WHERE id = ? AND operadora_id = ?", [departmentId, user.operadora_id], (deleteErr) => {
        if (deleteErr) {
          console.error(deleteErr);
          return res.status(500).send("Erro ao excluir setor.");
        }
        writeAdminAuditLog(req, "DELETE", "department_operadora", departmentId, `Setor #${departmentId} excluido pela operadora.`);
        return res.redirect("/operadora");
      });
    }
  );
});

app.post("/operadora/categories/:id/delete", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const categoryId = Number(req.params.id);

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).send("ID de categoria inválido.");
  }

  db.run(
    "UPDATE tickets SET category_id = NULL WHERE category_id = ? AND requester_id IN (SELECT id FROM users WHERE operadora_id = ?)",
    [categoryId, user.operadora_id],
    (updateErr) => {
    if (updateErr) {
      console.error(updateErr);
      return res.status(500).send("Erro ao desvincular categoria dos chamados.");
    }

    db.run("DELETE FROM categories WHERE id = ? AND operadora_id = ?", [categoryId, user.operadora_id], (deleteErr) => {
      if (deleteErr) {
        console.error(deleteErr);
        return res.status(500).send("Erro ao excluir categoria.");
      }
      writeAdminAuditLog(req, "DELETE", "category_operadora", categoryId, `Categoria #${categoryId} excluida pela operadora.`);
      return res.redirect("/operadora");
    });
    }
  );
});

app.post("/operadora/users", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const { name, email, password, role } = req.body;

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }

  if (!name || !email || !password) {
    return res.status(400).send("Nome, e-mail e senha são obrigatórios.");
  }

  const validRoles = ["user", "agent", "admin"];
  const userRole = validRoles.includes(role) ? role : "user";
  const passwordHash = bcrypt.hashSync(password, 10);

  db.run(
    "INSERT INTO users (name, email, password_hash, role, operadora_id) VALUES (?, ?, ?, ?, ?)",
    [name, email, passwordHash, userRole, user.operadora_id],
    function onCreateUser(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao criar usuário (verifique se o e-mail já não existe).");
      }
      writeAdminAuditLog(req, "CREATE", "user_operadora", this.lastID, `Usuário '${name}' criado na operadora.`);
      res.redirect("/operadora");
    }
  );
});

app.post("/operadora/users/:id/delete", ensureAuthenticated, requireRole(["admin"]), (req, res) => {
  const user = req.session.user;
  const userId = Number(req.params.id);

  if (!user.operadora_id) {
    return res.status(403).send("Acesso negado: operadora não configurada.");
  }

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send("ID de usuário inválido.");
  }

  db.get("SELECT operadora_id FROM users WHERE id = ?", [userId], (findErr, targetUser) => {
    if (findErr || !targetUser) {
      return res.status(404).send("Usuário não encontrado.");
    }

    if (targetUser.operadora_id !== user.operadora_id) {
      return res.status(403).send("Acesso negado: operadora diferente.");
    }

    db.run("DELETE FROM users WHERE id = ?", [userId], function onDeleteUser(err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Erro ao excluir usuário.");
      }
      writeAdminAuditLog(req, "DELETE", "user_operadora", userId, "Usuário excluído.");
      res.redirect("/operadora");
    });
  });
});

app.use((err, req, res, next) => {
  if (err && err.code === "EBADCSRFTOKEN") {
    if (req.path && req.path.startsWith("/admin/db-console")) {
      return res.redirect("/admin/db-console?error=csrf");
    }
    return res.status(403).send("Token CSRF inválido ou expirado. Recarregue a página e tente novamente.");
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`Help Desk rodando em http://localhost:${PORT}`);
});


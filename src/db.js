const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "..", "helpdesk.db");
const db = new sqlite3.Database(dbPath);

/**
 * Retorna a data/hora atual no fuso horário de Rio de Janeiro (America/Sao_Paulo)
 * no formato ISO 8601 (YYYY-MM-DD HH:MM:SS)
 */
function getNowBrazilTime() {
  const now = new Date();
  const brazilTime = new Intl.DateTimeFormat("pt-BR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(now);

  // Converte DD/MM/YYYY HH:MM:SS para YYYY-MM-DD HH:MM:SS
  const [date, time] = brazilTime.split(" ");
  const [day, month, year] = date.split("/");
  return `${year}-${month}-${day} ${time}`;
}

function hasTicketConstraints(tableSql) {
  if (!tableSql) return false;
  return tableSql.includes("CHECK (status IN")
    && tableSql.includes("'pausa'")
    && tableSql.includes("CHECK (priority IN");
}

function hasResolvedAtColumn(callback) {
  db.all("PRAGMA table_info(tickets)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const resolvedAtExists = Array.isArray(columns)
      && columns.some((column) => column.name === "resolved_at");

    return callback(null, resolvedAtExists);
  });
}

function getTicketsColumns(callback) {
  db.all("PRAGMA table_info(tickets)", (err, columns) => {
    if (err) {
      return callback(err);
    }
    return callback(null, Array.isArray(columns) ? columns : []);
  });
}

function migrateSlaPauseColumnsIfNeeded(callback) {
  getTicketsColumns((columnsErr, columns) => {
    if (columnsErr) {
      return callback(columnsErr);
    }

    const hasPausedAt = columns.some((column) => column.name === "sla_paused_at");
    const hasPausedSeconds = columns.some((column) => column.name === "sla_paused_seconds");

    db.serialize(() => {
      const ensurePausedAt = (next) => {
        if (hasPausedAt) return next(null);
        db.run("ALTER TABLE tickets ADD COLUMN sla_paused_at TEXT", (alterErr) => next(alterErr || null));
      };

      const ensurePausedSeconds = (next) => {
        if (hasPausedSeconds) return next(null);
        db.run(
          "ALTER TABLE tickets ADD COLUMN sla_paused_seconds INTEGER NOT NULL DEFAULT 0",
          (alterErr) => next(alterErr || null)
        );
      };

      ensurePausedAt((pausedAtErr) => {
        if (pausedAtErr) {
          return callback(pausedAtErr);
        }

        ensurePausedSeconds((pausedSecondsErr) => {
          if (pausedSecondsErr) {
            return callback(pausedSecondsErr);
          }

          return db.run(
            "UPDATE tickets SET sla_paused_seconds = 0 WHERE sla_paused_seconds IS NULL",
            (backfillErr) => callback(backfillErr || null)
          );
        });
      });
    });
  });
}

function hasCategoriesDefaultPriorityColumn(callback) {
  db.all("PRAGMA table_info(categories)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const exists = Array.isArray(columns)
      && columns.some((column) => column.name === "default_priority");

    return callback(null, exists);
  });
}

function hasDepartmentsOperadoraIdColumn(callback) {
  db.all("PRAGMA table_info(departments)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const exists = Array.isArray(columns)
      && columns.some((column) => column.name === "operadora_id");

    return callback(null, exists);
  });
}

function hasCategoriesOperadoraIdColumn(callback) {
  db.all("PRAGMA table_info(categories)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const exists = Array.isArray(columns)
      && columns.some((column) => column.name === "operadora_id");

    return callback(null, exists);
  });
}

function migrateDepartmentsAndCategoriesOperadoraIfNeeded(callback) {
  hasDepartmentsOperadoraIdColumn((depErr, depExists) => {
    if (depErr) {
      return callback(depErr);
    }

    hasCategoriesOperadoraIdColumn((catErr, catExists) => {
      if (catErr) {
        return callback(catErr);
      }

      if (depExists && catExists) {
        return callback(null);
      }

      const migrationSql = `
        PRAGMA foreign_keys = OFF;
        BEGIN TRANSACTION;

        CREATE TABLE IF NOT EXISTS departments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          operadora_id INTEGER,
          UNIQUE(name, operadora_id),
          FOREIGN KEY (operadora_id) REFERENCES operadoras(id)
        );

        INSERT INTO departments_new (id, name, operadora_id)
        SELECT id, name, NULL
        FROM departments;

        DROP TABLE departments;
        ALTER TABLE departments_new RENAME TO departments;

        CREATE TABLE IF NOT EXISTS categories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          default_priority TEXT NOT NULL DEFAULT 'media',
          operadora_id INTEGER,
          UNIQUE(name, operadora_id),
          FOREIGN KEY (operadora_id) REFERENCES operadoras(id)
        );

        INSERT INTO categories_new (id, name, default_priority, operadora_id)
        SELECT id, name, COALESCE(default_priority, 'media'), NULL
        FROM categories;

        DROP TABLE categories;
        ALTER TABLE categories_new RENAME TO categories;

        COMMIT;
        PRAGMA foreign_keys = ON;
      `;

      db.exec(migrationSql, (migrationErr) => {
        if (migrationErr) {
          return callback(migrationErr);
        }
        console.log("Migracao aplicada: departments/categories separados por operadora.");
        return callback(null);
      });
    });
  });
}

function migrateCategoriesDefaultPriorityIfNeeded(callback) {
  hasCategoriesDefaultPriorityColumn((columnErr, exists) => {
    if (columnErr) {
      return callback(columnErr);
    }

    if (exists) {
      return callback(null);
    }

    db.run(
      "ALTER TABLE categories ADD COLUMN default_priority TEXT NOT NULL DEFAULT 'media'",
      (alterErr) => callback(alterErr || null)
    );
  });
}

function migrateResolvedAtIfNeeded(callback) {
  hasResolvedAtColumn((columnErr, resolvedAtExists) => {
    if (columnErr) {
      return callback(columnErr);
    }

    if (resolvedAtExists) {
      return db.run(
        "UPDATE tickets SET resolved_at = updated_at WHERE resolved_at IS NULL AND status IN ('resolvido', 'fechado')",
        (backfillErr) => callback(backfillErr || null)
      );
    }

    db.serialize(() => {
      db.run("ALTER TABLE tickets ADD COLUMN resolved_at TEXT", (alterErr) => {
        if (alterErr) {
          return callback(alterErr);
        }

        db.run(
          "UPDATE tickets SET resolved_at = updated_at WHERE status IN ('resolvido', 'fechado')",
          (backfillErr) => callback(backfillErr || null)
        );
      });
    });
  });
}

function migrateTicketsTableIfNeeded(callback) {
  db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'", (err, row) => {
    if (err) {
      return callback(err);
    }

    if (hasTicketConstraints(row && row.sql)) {
      return callback(null);
    }

    const migrationSql = `
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;

      CREATE TABLE IF NOT EXISTS tickets_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'em_andamento', 'pausa', 'aguardando_usuario', 'resolvido', 'fechado')),
        priority TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa', 'media', 'alta', 'critica')),
        requester_id INTEGER NOT NULL,
        assignee_id INTEGER,
        department_id INTEGER,
        category_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        sla_paused_at TEXT,
        sla_paused_seconds INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (requester_id) REFERENCES users(id),
        FOREIGN KEY (assignee_id) REFERENCES users(id),
        FOREIGN KEY (department_id) REFERENCES departments(id),
        FOREIGN KEY (category_id) REFERENCES categories(id)
      );

      INSERT INTO tickets_new (
        id,
        title,
        description,
        status,
        priority,
        requester_id,
        assignee_id,
        department_id,
        category_id,
        created_at,
        updated_at,
        resolved_at,
        sla_paused_at,
        sla_paused_seconds
      )
      SELECT
        id,
        title,
        description,
        CASE
          WHEN status IN ('aberto', 'em_andamento', 'pausa', 'aguardando_usuario', 'resolvido', 'fechado') THEN status
          ELSE 'aberto'
        END,
        CASE
          WHEN priority IN ('baixa', 'media', 'alta', 'critica') THEN priority
          ELSE 'media'
        END,
        requester_id,
        assignee_id,
        department_id,
        category_id,
        created_at,
        updated_at,
        CASE
          WHEN status IN ('resolvido', 'fechado') THEN updated_at
          ELSE NULL
        END,
        CASE
          WHEN status = 'pausa' THEN updated_at
          ELSE NULL
        END,
        0
      FROM tickets;

      DROP TABLE tickets;
      ALTER TABLE tickets_new RENAME TO tickets;

      COMMIT;
      PRAGMA foreign_keys = ON;
    `;

    db.exec(migrationSql, (migrationErr) => {
      if (migrationErr) {
        return callback(migrationErr);
      }
      console.log("Migracao aplicada: constraints de status/prioridade em tickets.");
      return callback(null);
    });
  });
}

function hasEmpresaIdColumn(callback) {
  db.all("PRAGMA table_info(operadoras)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const empresaIdExists = Array.isArray(columns)
      && columns.some((column) => column.name === "empresa_id");

    return callback(null, empresaIdExists);
  });
}

function migrateAddEmpresaIdIfNeeded(callback) {
  hasEmpresaIdColumn((columnErr, exists) => {
    if (columnErr) {
      return callback(columnErr);
    }

    if (exists) {
      return callback(null);
    }

    db.run(
      "ALTER TABLE operadoras ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)",
      (alterErr) => {
        if (alterErr) {
          return callback(alterErr);
        }
        console.log("Migracao aplicada: coluna empresa_id adicionada a tabela operadoras.");
        return callback(null);
      }
    );
  });
}

function hasOperadoraIdColumn(callback) {
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
      return callback(err);
    }

    const operadoraIdExists = Array.isArray(columns)
      && columns.some((column) => column.name === "operadora_id");

    return callback(null, operadoraIdExists);
  });
}

function migrateAddOperadoraIdIfNeeded(callback) {
  hasOperadoraIdColumn((columnErr, exists) => {
    if (columnErr) {
      return callback(columnErr);
    }

    if (exists) {
      return callback(null);
    }

    db.run(
      "ALTER TABLE users ADD COLUMN operadora_id INTEGER REFERENCES operadoras(id)",
      (alterErr) => {
        if (alterErr) {
          return callback(alterErr);
        }
        console.log("Migracao aplicada: coluna operadora_id adicionada a tabela users.");
        return callback(null);
      }
    );
  });
}

function seedInitialAdmin() {
  // usuario admin inicial
  db.get(`SELECT COUNT(*) AS count FROM users`, (err, row) => {
    if (err) {
      console.error("Erro ao verificar usuarios iniciais:", err);
      return;
    }
    if (row.count === 0) {
      const bcrypt = require("bcryptjs");

      const adminEmail = process.env.ADMIN_EMAIL || "admin@empresa.com";
      const adminPasswordFromEnv = process.env.ADMIN_PASSWORD || "";
      const generatedAdminPassword = crypto.randomBytes(24).toString("base64url");
      const adminPassword = adminPasswordFromEnv || generatedAdminPassword;
      const isGeneratedPassword = !adminPasswordFromEnv;

      if (adminPassword.length < 12) {
        console.error(
          "ADMIN_PASSWORD invalida: use ao menos 12 caracteres para criar o admin inicial."
        );
        return;
      }

      const passwordHash = bcrypt.hashSync(adminPassword, 10);
      db.run(
        `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
        ["Administrador", adminEmail, passwordHash, "admin"],
        (err2) => {
          if (err2) {
            console.error("Erro ao criar usuario admin padrao:", err2);
          } else if (isGeneratedPassword) {
            console.log("Admin inicial criado com senha aleatoria forte.");
            console.log(`E-mail: ${adminEmail}`);
            console.log(`Senha temporaria: ${generatedAdminPassword}`);
            console.log("Altere essa senha imediatamente em Minha conta.");
          } else {
            console.log(`Admin inicial criado com ADMIN_EMAIL=${adminEmail}.`);
          }
        }
      );
    }
  });
}

function seedInitialEmpresas() {
  db.get("SELECT id FROM empresas WHERE name = ?", ["Grupo AMEP"], (err, row) => {
    if (err) {
      console.error("Erro ao verificar empresa:", err);
      return;
    }

    if (!row) {
      db.run(
        "INSERT INTO empresas (name, created_at) VALUES (?, ?)",
        ["Grupo AMEP", getNowBrazilTime()],
        (insertErr) => {
          if (insertErr) {
            console.error("Erro ao criar empresa:", insertErr);
            return;
          }
          console.log("Empresa 'Grupo AMEP' criada automaticamente.");
          
          // Após criar a empresa, cria as operadoras
          seedInitialOperadoras();
        }
      );
    } else {
      // Empresa já existe, cria operadoras
      seedInitialOperadoras();
    }
  });
}

function seedInitialOperadoras() {
  db.get("SELECT id FROM empresas LIMIT 1", [], (err, empresa) => {
    if (err || !empresa) {
      console.error("Erro: empresa não encontrada para criar operadoras");
      return;
    }

    const operadorasDefault = ["AMEP", "Operadora"];
    let created = 0;

    operadorasDefault.forEach((nome) => {
      db.get("SELECT id FROM operadoras WHERE name = ? AND empresa_id = ?", [nome, empresa.id], (err, row) => {
        if (err) {
          console.error(`Erro ao verificar operadora ${nome}:`, err);
          return;
        }

        if (!row) {
          db.run(
            "INSERT INTO operadoras (name, empresa_id, created_at) VALUES (?, ?, ?)",
            [nome, empresa.id, getNowBrazilTime()],
            (insertErr) => {
              if (insertErr) {
                console.error(`Erro ao criar operadora ${nome}:`, insertErr);
              } else {
                console.log(`Operadora '${nome}' criada automaticamente.`);
                created++;
              }
            }
          );
        }
      });
    });
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS empresas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS operadoras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      empresa_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(name, empresa_id),
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'admin')),
      operadora_id INTEGER,
      FOREIGN KEY (operadora_id) REFERENCES operadoras(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      operadora_id INTEGER,
      UNIQUE(name, operadora_id),
      FOREIGN KEY (operadora_id) REFERENCES operadoras(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      default_priority TEXT NOT NULL DEFAULT 'media',
      operadora_id INTEGER,
      UNIQUE(name, operadora_id),
      FOREIGN KEY (operadora_id) REFERENCES operadoras(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'em_andamento', 'pausa', 'aguardando_usuario', 'resolvido', 'fechado')),
      priority TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa', 'media', 'alta', 'critica')),
      requester_id INTEGER NOT NULL,
      assignee_id INTEGER,
      department_id INTEGER,
      category_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      sla_paused_at TEXT,
      sla_paused_seconds INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (assignee_id) REFERENCES users(id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES users(id)
    )
  `);

  migrateTicketsTableIfNeeded((migrationErr) => {
    if (migrationErr) {
      console.error("Erro ao aplicar migracao da tabela tickets:", migrationErr);
      return;
    }

    migrateResolvedAtIfNeeded((resolvedAtErr) => {
      if (resolvedAtErr) {
        console.error("Erro ao aplicar migracao da coluna resolved_at:", resolvedAtErr);
        return;
      }

      migrateSlaPauseColumnsIfNeeded((slaPauseErr) => {
        if (slaPauseErr) {
          console.error("Erro ao aplicar migracao das colunas de pausa da SLA:", slaPauseErr);
          return;
        }

        migrateCategoriesDefaultPriorityIfNeeded((categoriesErr) => {
          if (categoriesErr) {
            console.error(
              "Erro ao aplicar migracao da coluna default_priority em categories:",
              categoriesErr
            );
            return;
          }

          migrateAddOperadoraIdIfNeeded((operadoraErr) => {
            if (operadoraErr) {
              console.error("Erro ao aplicar migracao de operadora_id:", operadoraErr);
              return;
            }

            migrateAddEmpresaIdIfNeeded((empresaErr) => {
              if (empresaErr) {
                console.error("Erro ao aplicar migracao de empresa_id:", empresaErr);
                return;
              }

              migrateDepartmentsAndCategoriesOperadoraIfNeeded((scopeErr) => {
                if (scopeErr) {
                  console.error("Erro ao aplicar migracao de departments/categories por operadora:", scopeErr);
                  return;
                }

                seedInitialEmpresas();
                seedInitialAdmin();
              });
            });
          });
        });
      });
    });
  });
});

module.exports = db;
module.exports.getNowBrazilTime = getNowBrazilTime;


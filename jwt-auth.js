/**
 * jwt-auth.js
 * Middleware pour l'authentification JWT
 * Gère : création de token, validation, et renouvellement via refresh token
 */

const crypto = require("crypto");

// ─────────────────────────────────────────────
// Base utilisateurs : Map<username, UserRecord>
// ─────────────────────────────────────────────
const userDatabase = new Map([
  [
    "alice",
    {
      id: "usr_001",
      username: "alice",
      // hash SHA-256 de "password123" (à remplacer par bcrypt en prod)
      passwordHash: hashPassword("password123"),
      roles: ["admin", "editor"],
      permissions: ["read", "write", "delete", "manage_users"],
    },
  ],
  [
    "bob",
    {
      id: "usr_002",
      username: "bob",
      passwordHash: hashPassword("secret456"),
      roles: ["editor"],
      permissions: ["read", "write"],
    },
  ],
  [
    "charlie",
    {
      id: "usr_003",
      username: "charlie",
      passwordHash: hashPassword("pass789"),
      roles: ["viewer"],
      permissions: ["read"],
    },
  ],
]);

// ─────────────────────────────────────────────
// Configuration par défaut
// ─────────────────────────────────────────────
const DEFAULT_CONFIG = {
  accessTokenSecret: "access-secret-change-in-production",
  refreshTokenSecret: "refresh-secret-change-in-production",
  accessTokenExpiry: 15 * 60,        // 15 minutes (en secondes)
  refreshTokenExpiry: 7 * 24 * 3600, // 7 jours (en secondes)
  issuer: "jwt-auth",
  checkIssuer: false,
  alg: "HS256",

  username: (user) => user.username,

  fetchUser: (username) => userDatabase.get(username), // min { username, passwordHash = SHA256(password) }
  checkPassword: (user, password) => user.passwordHash !== hashPassword(password),

  payload: (user) => ({ 
    sub:user.id,
    username:user.username, 
    roles: user.roles,
    permissions: user.permissions,
   }),
  // Stockage des refresh tokens actifs : Map<refreshToken, tokenData>
  refreshTokenStore: new Map(), // OR { set(key,value), get(key), delete(key), has(key) }
  // purge of refresh-token is not handled
};

/**
 * Hash simple d'un mot de passe (utiliser bcrypt en production !)
 */
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// ─────────────────────────────────────────────
// Utilitaires JWT (implémentation manuelle Base64URL)
// ─────────────────────────────────────────────

function base64UrlEncode(data) {
  return Buffer.from(JSON.stringify(data))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str) {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return JSON.parse(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
  );
}

function createSignature(header, payload, secret) {
  // TODO -- HS, RS, ES, PS...
  if (header.alg == "HS256" || header.alg == "HS384" || header.alg == "HS512")
    return crypto
      .createHmac("sha"+header.alg.substr(2), secret)
      .update(`${header}.${payload}`)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  throw new Error(`Unsupported sign algorithm`) 
}

/**
 * Génère un token JWT signé (HS256)
 */
function signToken(payload, secret, expiresIn, alg) {
  const header = base64UrlEncode({ alg: alg ?? "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = base64UrlEncode({
    ...payload,
    iat: now,
    exp: now + expiresIn,
  });
  const signature = createSignature(header, fullPayload, secret);
  return `${header}.${fullPayload}.${signature}`;
}

/**
 * Vérifie et décode un token JWT
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
function verifyToken(token, secret, alg) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, error: "Format de token invalide" };

    const [header, payload, signature] = parts;
    if (header.alg !== alg)
      return { valid: false, error: "Algorithme de signature non authorizé" };
    const expectedSig = createSignature(header, payload, secret);

    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSig)
      )
    ) {
      return { valid: false, error: "Signature invalide" };
    }

    const decoded = base64UrlDecode(payload);
    const now = Math.floor(Date.now() / 1000);

    if (decoded.exp && decoded.exp < now) {
      return { valid: false, error: "Token expiré" };
    }

    return { valid: true, payload: decoded };
  } catch {
    return { valid: false, error: "Token malformé" };
  }
}

/**
 * Génère un refresh token opaque aléatoire
 */
function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

// ─────────────────────────────────────────────
// Logique métier
// ─────────────────────────────────────────────

/**
 * Authentifie un utilisateur et retourne access + refresh tokens
 */
function authenticateUser(username, password, config) {
  const user = config.fetchUser(username);
  if (!user) return { success: false, error: "Utilisateur introuvable" };

  if (config.checkPassword(user, password)) {
    return { success: false, error: "Mot de passe incorrect" };
  }

  return issueTokenPair(user, config);
}

/**
 * Émet une paire access/refresh token pour un utilisateur
 */
function issueTokenPair(user, config) {
  const username = config.username(user);
  const payload = config.payload(user);
  payload.iss = config.issuer;
  if (!payload.sub)
    payload.sub = username;

  const accessToken = signToken(payload, config.accessTokenSecret, config.accessTokenExpiry, config.alg);
  const refreshToken = generateRefreshToken();

  // Stocker le refresh token avec les métadonnées
  config.refreshTokenStore.set(refreshToken, {
    username: username,
    issuedAt: Date.now(),
    expiresAt: Date.now() + config.refreshTokenExpiry * 1000,
  });

  return {
    success: true,
    accessToken,
    refreshToken,
    expiresIn: config.accessTokenExpiry,
    tokenType: "Bearer",
  };
}

/**
 * Renouvelle un access token à partir d'un refresh token valide
 */
function renewAccessToken(username, refreshToken, config) {
  const tokenData = config.refreshTokenStore.get(refreshToken);

  if (!tokenData || tokenData.username != username) {
    return { success: false, error: "Refresh token invalide ou révoqué" };
  }

  if (Date.now() > tokenData.expiresAt) {
    config.refreshTokenStore.delete(refreshToken);
    return { success: false, error: "Refresh token expiré" };
  }

  const user = config.fetchUser(tokenData.username);
  if (!user) {
    config.refreshTokenStore.delete(refreshToken);
    return { success: false, error: "Utilisateur introuvable" };
  }

  // Rotation du refresh token (sécurité renforcée)
  config.refreshTokenStore.delete(refreshToken);
  return issueTokenPair(user, config);
}

/**
 * Révoque un refresh token (logout)
 */
function revokeRefreshToken(refreshToken) {
  const existed = config.refreshTokenStore.has(refreshToken);
  config.refreshTokenStore.delete(refreshToken);
  return existed;
}

// ─────────────────────────────────────────────
// Factory du plugin Express
// ─────────────────────────────────────────────

/**
 * Crée le plugin JWT pour Express
 * @param {object} userConfig - Configuration optionnelle
 * @returns {object} - { router, authenticate, requirePermission, requireRole }
 */
function createJwtPlugin(router, userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  // ── POST /auth/login ──────────────────────────
  function login(req, res) {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "Les champs 'username' et 'password' sont requis",
      });
    }

    const result = authenticateUser(username, password, config);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({
      message: "Authentification réussie",
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
    });
  };

  // ── POST /auth/refresh ────────────────────────
  function refresh(req, res) {
    const { username, refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: "Le 'refreshToken' est requis" });
    }

    const result = renewAccessToken(username, refreshToken, config);

    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }

    res.json({
      message: "Token renouvelé avec succès",
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: result.tokenType,
    });
  };

  // ── POST /auth/logout ─────────────────────────
  function logout(req, res) {
    const { refreshToken } = req.body;

    if (refreshToken) {
      revokeRefreshToken(refreshToken);
    }

    res.json({ message: "Déconnexion réussie" });
  };

  // ─────────────────────────────────────────────
  // Middleware d'authentification
  // ─────────────────────────────────────────────

  /**
   * Middleware : vérifie le Bearer token dans Authorization header
   * Injecte req.user si valide
   */
  function authenticate(req, res, next) {
    const authHeader = req.headers["authorization"];
    if (req.user)
      delete req.user;

    if (!authHeader || !authHeader.startsWith("Bearer ")) 
      return next(); // Token manquant. Header attendu : Authorization: Bearer <token>
  
    const token = authHeader.slice(7);
    const result = verifyToken(token, config.accessTokenSecret, config.alg);

    if (!result.valid)
      return next();
  
    if (config.checkIssuer && result.payload != config.issuer) 
      return next(); // Issuer is incorrect

    req.user = result.payload;
    next();
  }

  /**
   * Middleware : reject the request if the user is not authentificated
   */
  function authorize(req, res, next) {
    if (!req.user)
      return res.status(401).json({ error: 'You need to be authentificated to access this resource' });
    next();
  }

  /**
   * Middleware factory : exige un rôle spécifique
   * @param {...string} roles
   */
  function requireRole(...roles) {
    return [
      authenticate,
      (req, res, next) => {
        const userRoles = req.user.roles || [];
        const hasRole = roles.some((r) => userRoles.includes(r));

        if (!hasRole) {
          return res.status(403).json({
            error: `Accès refusé. Rôle(s) requis : ${roles.join(", ")}`,
            yourRoles: userRoles,
          });
        }
        next();
      },
    ];
  }

  /**
   * Middleware factory : exige une permission spécifique
   * @param {...string} permissions
   */
  function requirePermission(...permissions) {
    return [
      authenticate,
      (req, res, next) => {
        const userPerms = req.user.permissions || [];
        const hasAll = permissions.every((p) => userPerms.includes(p));

        if (!hasAll) {
          return res.status(403).json({
            error: `Permission(s) insuffisante(s). Requises : ${permissions.join(", ")}`,
            yourPermissions: userPerms,
          });
        }
        next();
      },
    ];
  }

  return {
    login,         // Middleware to login { username, password }
    refresh,       // Middleware to refresh { username, refreshToken }
    logout,        // Middleware to logout { refreshToken:boolean }
    authenticate,  // Middleware de validation du token
    authorize,
    requireRole,   // Middleware factory de contrôle par rôle
    requirePermission, // Middleware factory de contrôle par permission
  };
}

module.exports = { createJwtPlugin, userDatabase };

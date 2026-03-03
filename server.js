// ─────────────────────────────────────────────────────────────
//  PilotePME - Backend Railway
//  Connexion Bridge API (Open Banking)
//  Déployer sur Railway.app
// ─────────────────────────────────────────────────────────────

const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ── Variables d'environnement (à définir dans Railway) ────────
const CLIENT_ID     = process.env.BRIDGE_CLIENT_ID;
const CLIENT_SECRET = process.env.BRIDGE_CLIENT_SECRET;
const BRIDGE_URL    = "https://api.bridgeapi.io";
const API_VERSION   = "2021-06-01";

// Headers communs Bridge
const bridgeHeaders = (token = null) => ({
  "Content-Type":        "application/json",
  "Bridge-Version":      API_VERSION,
  "Client-Id":           CLIENT_ID,
  "Client-Secret":       CLIENT_SECRET,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// ── Stockage en mémoire (simple pour MVP) ─────────────────────
// En production, utiliser une vraie base de données (Postgres sur Railway)
const sessions = {};

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => res.json({ status: "ok", app: "PilotePME Backend" }));

// 1. Créer un utilisateur Bridge + récupérer le lien de connexion bancaire
app.post("/api/auth/connect", async (req, res) => {
  try {
    const { userEmail } = req.body;
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    // Créer l'utilisateur dans Bridge
    const userRes = await fetch(`${BRIDGE_URL}/v2/users`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ email: userEmail, password: generatePassword() }),
    });
    const user = await userRes.json();
    if (!user.uuid) return res.status(400).json({ error: "Erreur création utilisateur Bridge", details: user });

    // Authentifier l'utilisateur pour obtenir un access token
    const authRes = await fetch(`${BRIDGE_URL}/v2/authenticate`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ email: user.email, password: user.password }),
    });
    const auth = await authRes.json();
    if (!auth.access_token) return res.status(400).json({ error: "Erreur authentification Bridge", details: auth });

    // Stocker le token en session
    sessions[userEmail] = {
      access_token: auth.access_token,
      user_uuid:    user.uuid,
      email:        userEmail,
      password:     user.password,
    };

    // Créer le lien de connexion bancaire (Connect Item)
    const connectRes = await fetch(`${BRIDGE_URL}/v2/connect/items/add/url?country=fr`, {
      method:  "GET",
      headers: bridgeHeaders(auth.access_token),
    });
    const connect = await connectRes.json();

    res.json({
      success:      true,
      connect_url:  connect.url,   // URL à ouvrir pour que l'utilisateur connecte sa banque
      userEmail,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Récupérer les comptes bancaires
app.get("/api/accounts", async (req, res) => {
  try {
    const { email } = req.query;
    const session   = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée. Reconnecte-toi." });

    const token = await refreshTokenIfNeeded(session);

    const accountsRes = await fetch(`${BRIDGE_URL}/v2/accounts`, {
      headers: bridgeHeaders(token),
    });
    const data = await accountsRes.json();

    // Formater les comptes pour l'app
    const comptes = (data.resources || []).map(c => ({
      id:       c.id,
      nom:      c.name,
      iban:     c.iban,
      solde:    c.balance,
      devise:   c.currency_code,
      banque:   c.bank?.name || "Banque inconnue",
      type:     c.type,
      updated:  c.updated_at,
    }));

    res.json({ comptes });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Récupérer les transactions d'un compte
app.get("/api/transactions", async (req, res) => {
  try {
    const { email, account_id, limit = 50 } = req.query;
    const session = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });

    const token = await refreshTokenIfNeeded(session);

    const url = account_id
      ? `${BRIDGE_URL}/v2/accounts/${account_id}/transactions?limit=${limit}`
      : `${BRIDGE_URL}/v2/transactions?limit=${limit}`;

    const txRes = await fetch(url, {
      headers: bridgeHeaders(token),
    });
    const data = await txRes.json();

    // Formater les transactions
    const transactions = (data.resources || []).map(t => ({
      id:          t.id,
      date:        t.date,
      description: t.label,
      montant:     t.amount,
      categorie:   t.category?.name || "Autre",
      is_future:   t.is_future || false,
    }));

    res.json({ transactions });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Résumé trésorerie (solde + prévisions basées sur transactions)
app.get("/api/tresorerie", async (req, res) => {
  try {
    const { email } = req.query;
    const session   = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });

    const token = await refreshTokenIfNeeded(session);

    // Récupérer tous les comptes
    const accountsRes = await fetch(`${BRIDGE_URL}/v2/accounts`, {
      headers: bridgeHeaders(token),
    });
    const accountsData = await accountsRes.json();
    const comptes      = accountsData.resources || [];

    // Solde total
    const soldeTotal = comptes.reduce((sum, c) => sum + (c.balance || 0), 0);

    // Transactions futures (prévisions)
    const txRes  = await fetch(`${BRIDGE_URL}/v2/transactions?limit=200`, {
      headers: bridgeHeaders(token),
    });
    const txData = await txRes.json();
    const txs    = txData.resources || [];

    const today      = new Date();
    const futuresTx  = txs.filter(t => t.is_future);

    const calcPrevision = (jours) => {
      const limite = new Date(today);
      limite.setDate(limite.getDate() + jours);
      return futuresTx
        .filter(t => new Date(t.date) <= limite)
        .reduce((sum, t) => sum + t.amount, 0);
    };

    res.json({
      solde_actuel: soldeTotal,
      solde_30j:    soldeTotal + calcPrevision(30),
      solde_60j:    soldeTotal + calcPrevision(60),
      solde_90j:    soldeTotal + calcPrevision(90),
      nb_comptes:   comptes.length,
      comptes:      comptes.map(c => ({ nom: c.name, solde: c.balance, banque: c.bank?.name })),
      derniere_maj: new Date().toISOString(),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────

function generatePassword() {
  return Math.random().toString(36).slice(-12) + "Aa1!";
}

async function refreshTokenIfNeeded(session) {
  // Pour simplifier le MVP, on re-authentifie à chaque fois
  // En production : stocker l'expiry et ne rafraîchir que si nécessaire
  try {
    const authRes = await fetch(`${BRIDGE_URL}/v2/authenticate`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ email: session.email, password: session.password }),
    });
    const auth = await authRes.json();
    if (auth.access_token) {
      session.access_token = auth.access_token;
      return auth.access_token;
    }
  } catch (e) {
    console.error("Erreur refresh token:", e);
  }
  return session.access_token;
}

// ── Démarrage serveur ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PilotePME backend démarré sur le port ${PORT}`));

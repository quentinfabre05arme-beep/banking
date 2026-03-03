const express = require("express");
const cors    = require("cors");
const fetch   = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID     = process.env.BRIDGE_CLIENT_ID;
const CLIENT_SECRET = process.env.BRIDGE_CLIENT_SECRET;
const BRIDGE_URL    = "https://api.bridgeapi.io";
const API_VERSION   = "2025-01-15";

const bridgeHeaders = (token = null) => {
  const h = {
    "Content-Type":   "application/json",
    "Bridge-Version": API_VERSION,
    "Client-Id":      CLIENT_ID,
    "Client-Secret":  CLIENT_SECRET,
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
};

const sessions = {};

// Health check
app.get("/", (req, res) => res.json({
  status: "ok",
  app: "PilotePME Backend",
  bridge_client_id_set: !!CLIENT_ID,
  bridge_secret_set: !!CLIENT_SECRET,
}));

// Debug - teste plusieurs endpoints pour trouver le bon
app.get("/api/debug", async (req, res) => {
  const results = {};

  // Test v2/users
  try {
    const r = await fetch(`${BRIDGE_URL}/v2/users`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify({ email: `test_${Date.now()}@pilotepme.fr`, password: "TestPilote1!" }),
    });
    results.v2_users = { status: r.status, body: await r.json() };
  } catch(e) { results.v2_users = { error: e.message }; }

  // Test v3/users
  try {
    const r = await fetch(`${BRIDGE_URL}/v3/users`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify({ email: `test_${Date.now()}@pilotepme.fr`, password: "TestPilote1!" }),
    });
    results.v3_users = { status: r.status, body: await r.json() };
  } catch(e) { results.v3_users = { error: e.message }; }

  // Test connect URL sans user (flow PKCE)
  try {
    const r = await fetch(`${BRIDGE_URL}/v2/connect/items/add/url?country=fr`, {
      headers: bridgeHeaders(),
    });
    results.connect_url_no_auth = { status: r.status, body: await r.json() };
  } catch(e) { results.connect_url_no_auth = { error: e.message }; }

  res.json(results);
});

// Connexion bancaire
app.post("/api/auth/connect", async (req, res) => {
  try {
    const { userEmail } = req.body;
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const password = `Pilote${Date.now()}!Aa`;

    // Créer utilisateur
    const userRes = await fetch(`${BRIDGE_URL}/v2/users`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ email: userEmail, password }),
    });
    const user = await userRes.json();
    console.log("create user:", userRes.status, JSON.stringify(user));

    if (![200, 201].includes(userRes.status) && user.type !== "users_already_exist") {
      return res.status(400).json({ error: `Bridge: ${user.message || user.errors?.[0]?.message || JSON.stringify(user)}` });
    }

    // Authentifier
    const authRes = await fetch(`${BRIDGE_URL}/v2/authenticate`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ email: userEmail, password }),
    });
    const auth = await authRes.json();
    console.log("auth:", authRes.status, JSON.stringify(auth));

    if (!auth.access_token) {
      return res.status(400).json({ error: `Auth Bridge: ${auth.message || JSON.stringify(auth)}` });
    }

    sessions[userEmail] = { access_token: auth.access_token, email: userEmail, password };

    // URL de connexion bancaire
    const connectRes = await fetch(`${BRIDGE_URL}/v2/connect/items/add/url?country=fr`, {
      headers: bridgeHeaders(auth.access_token),
    });
    const connect = await connectRes.json();
    console.log("connect url:", connectRes.status, JSON.stringify(connect));

    res.json({ success: true, connect_url: connect.url, userEmail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Comptes
app.get("/api/accounts", async (req, res) => {
  try {
    const { email } = req.query;
    const session = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token = await refreshToken(session);
    const r = await fetch(`${BRIDGE_URL}/v2/accounts`, { headers: bridgeHeaders(token) });
    const data = await r.json();
    const comptes = (data.resources || []).map(c => ({ id: c.id, nom: c.name, solde: c.balance, banque: c.bank?.name || "Banque", iban: c.iban }));
    res.json({ comptes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transactions
app.get("/api/transactions", async (req, res) => {
  try {
    const { email, limit = 50 } = req.query;
    const session = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token = await refreshToken(session);
    const r = await fetch(`${BRIDGE_URL}/v2/transactions?limit=${limit}`, { headers: bridgeHeaders(token) });
    const data = await r.json();
    const transactions = (data.resources || []).map(t => ({ id: t.id, date: t.date, description: t.label, montant: t.amount, categorie: t.category?.name || "Autre" }));
    res.json({ transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trésorerie
app.get("/api/tresorerie", async (req, res) => {
  try {
    const { email } = req.query;
    const session = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token = await refreshToken(session);
    const [r1, r2] = await Promise.all([
      fetch(`${BRIDGE_URL}/v2/accounts`, { headers: bridgeHeaders(token) }),
      fetch(`${BRIDGE_URL}/v2/transactions?limit=200`, { headers: bridgeHeaders(token) }),
    ]);
    const { resources: comptes = [] } = await r1.json();
    const { resources: txs = [] } = await r2.json();
    const solde = comptes.reduce((s, c) => s + (c.balance || 0), 0);
    const today = new Date();
    const prevision = (jours) => {
      const limite = new Date(today);
      limite.setDate(limite.getDate() + jours);
      return txs.filter(t => t.is_future && new Date(t.date) <= limite).reduce((s, t) => s + t.amount, 0);
    };
    res.json({
      solde_actuel: solde,
      solde_30j: solde + prevision(30),
      solde_60j: solde + prevision(60),
      solde_90j: solde + prevision(90),
      comptes: comptes.map(c => ({ nom: c.name, solde: c.balance, banque: c.bank?.name })),
      derniere_maj: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function refreshToken(session) {
  try {
    const r = await fetch(`${BRIDGE_URL}/v2/authenticate`, {
      method: "POST",
      headers: bridgeHeaders(),
      body: JSON.stringify({ email: session.email, password: session.password }),
    });
    const data = await r.json();
    if (data.access_token) { session.access_token = data.access_token; return data.access_token; }
  } catch (e) { console.error("Refresh token error:", e); }
  return session.access_token;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PilotePME backend démarré sur le port ${PORT}`));

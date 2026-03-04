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
    "accept":         "application/json",
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

// Debug
app.get("/api/debug", async (req, res) => {
  const results = {};
  const testId  = `pilote_${Date.now()}`;

  // 1. Créer un utilisateur v3
  try {
    const r = await fetch(`${BRIDGE_URL}/v3/aggregation/users`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ external_user_id: testId }),
    });
    results.create_user = { status: r.status, body: await r.json() };
  } catch(e) { results.create_user = { error: e.message }; }

  // 2. Obtenir un token v3
  try {
    const r = await fetch(`${BRIDGE_URL}/v3/aggregation/authorization/token`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ external_user_id: testId }),
    });
    results.get_token = { status: r.status, body: await r.json() };
  } catch(e) { results.get_token = { error: e.message }; }

  // 3. Test connect-sessions avec token obtenu
  if (results.get_token?.body?.access_token) {
    try {
      const token = results.get_token.body.access_token;
      const r = await fetch(`${BRIDGE_URL}/v3/aggregation/connect-sessions`, {
        method: "POST",
        headers: bridgeHeaders(token),
        body: JSON.stringify({ user_email: `debug_${Date.now()}@pilotepme.fr` }),
      });
      results.connect_session = { status: r.status, body: await r.json() };
    } catch(e) { results.connect_session = { error: e.message }; }
  }

  res.json(results);
});

// 1. Connexion bancaire
app.post("/api/auth/connect", async (req, res) => {
  try {
    const { userEmail } = req.body;
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    // Utiliser l'email comme external_user_id (unique par utilisateur)
    const externalId = userEmail.replace(/[^a-zA-Z0-9]/g, "_");

    // Créer l'utilisateur Bridge (idempotent - ok s'il existe déjà)
    const userRes = await fetch(`${BRIDGE_URL}/v3/aggregation/users`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ external_user_id: externalId }),
    });
    const user = await userRes.json();
    console.log("create user:", userRes.status, JSON.stringify(user));

    // Obtenir un token
    const tokenRes = await fetch(`${BRIDGE_URL}/v3/aggregation/authorization/token`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ external_user_id: externalId }),
    });
    const tokenData = await tokenRes.json();
    console.log("get token:", tokenRes.status, JSON.stringify(tokenData));

    if (!tokenData.access_token) {
      return res.status(400).json({
        error: `Erreur token Bridge : ${tokenData.message || tokenData.errors?.[0]?.message || JSON.stringify(tokenData)}`,
      });
    }

    sessions[userEmail] = {
      access_token: tokenData.access_token,
      external_id:  externalId,
      email:        userEmail,
    };

    // Créer une session de connexion bancaire
    const connectRes = await fetch(`${BRIDGE_URL}/v3/aggregation/connect-sessions`, {
      method:  "POST",
      headers: bridgeHeaders(tokenData.access_token),
      body:    JSON.stringify({ user_email: userEmail }),
    });
    const connect = await connectRes.json();
    console.log("connect session:", connectRes.status, JSON.stringify(connect));

    if (!connect.url) {
      return res.status(400).json({
        error: `Erreur session Bridge : ${connect.message || connect.errors?.[0]?.message || JSON.stringify(connect)}`,
      });
    }

    res.json({ success: true, connect_url: connect.url, userEmail });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Comptes bancaires
app.get("/api/accounts", async (req, res) => {
  try {
    const { email } = req.query;
    const session   = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token = await refreshToken(session);
    const r     = await fetch(`${BRIDGE_URL}/v3/aggregation/accounts`, { headers: bridgeHeaders(token) });
    const data  = await r.json();
    const comptes = (data.resources || []).map(c => ({
      id:     c.id,
      nom:    c.name,
      solde:  c.balance,
      banque: c.provider?.name || "Banque",
      iban:   c.iban,
    }));
    res.json({ comptes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Transactions
app.get("/api/transactions", async (req, res) => {
  try {
    const { email, limit = 50 } = req.query;
    const session = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token = await refreshToken(session);
    const r     = await fetch(`${BRIDGE_URL}/v3/aggregation/transactions?limit=${limit}`, { headers: bridgeHeaders(token) });
    const data  = await r.json();
    const transactions = (data.resources || []).map(t => ({
      id:          t.id,
      date:        t.date,
      description: t.label,
      montant:     t.amount,
      categorie:   t.category?.name || "Autre",
    }));
    res.json({ transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Trésorerie
app.get("/api/tresorerie", async (req, res) => {
  try {
    const { email } = req.query;
    const session   = sessions[email];
    if (!session) return res.status(401).json({ error: "Session non trouvée." });
    const token     = await refreshToken(session);
    const [r1, r2]  = await Promise.all([
      fetch(`${BRIDGE_URL}/v3/aggregation/accounts`, { headers: bridgeHeaders(token) }),
      fetch(`${BRIDGE_URL}/v3/aggregation/transactions?limit=200`, { headers: bridgeHeaders(token) }),
    ]);
    const { resources: comptes = [] } = await r1.json();
    const { resources: txs = [] }     = await r2.json();
    const solde   = comptes.reduce((s, c) => s + (c.balance || 0), 0);
    const today   = new Date();
    const prevision = (jours) => {
      const limite = new Date(today);
      limite.setDate(limite.getDate() + jours);
      return txs
        .filter(t => t.is_future && new Date(t.date) <= limite)
        .reduce((s, t) => s + t.amount, 0);
    };
    res.json({
      solde_actuel: solde,
      solde_30j:    solde + prevision(30),
      solde_60j:    solde + prevision(60),
      solde_90j:    solde + prevision(90),
      comptes:      comptes.map(c => ({ nom: c.name, solde: c.balance, banque: c.provider?.name })),
      derniere_maj: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper : refresh token
async function refreshToken(session) {
  try {
    const r = await fetch(`${BRIDGE_URL}/v3/aggregation/authorization/token`, {
      method:  "POST",
      headers: bridgeHeaders(),
      body:    JSON.stringify({ external_user_id: session.external_id }),
    });
    const data = await r.json();
    if (data.access_token) { session.access_token = data.access_token; return data.access_token; }
  } catch (e) { console.error("Refresh token error:", e); }
  return session.access_token;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PilotePME backend démarré sur le port ${PORT}`));

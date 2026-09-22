// Netlify Serverless Function para armazenamento centralizado e persistente do CRM ProFinance
let getStore;
try {
  getStore = require("@netlify/blobs").getStore;
} catch (e) {}

let memoryStore = null;

const ADMIN_AUTH_HASH = process.env.PROFIN_ADMIN_TOKEN || "9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b";

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    let store = null;
    if (getStore) {
      try {
        store = getStore("profinance_crm");
      } catch (e) {}
    }

    const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isAdmin = (token === ADMIN_AUTH_HASH);

    if (event.httpMethod === "POST") {
      if (!isAdmin) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: "Unauthorized: Acesso restrito ao Administrador Master." })
        };
      }

      const payload = JSON.parse(event.body || "{}");
      if (store) {
        try {
          await store.setJSON("state", payload);
        } catch (e) {
          memoryStore = payload;
        }
      } else {
        memoryStore = payload;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, count: (payload.licenses || []).length })
      };
    }

    // GET
    let data = null;
    if (store) {
      try {
        data = await store.get("state", { type: "json" });
      } catch (e) {}
    }
    if (!data) data = memoryStore || { licenses: [], revoked: [], deletedIds: [], pix: "" };

    // 1. Requisição autenticada como Administrador Master: retorna o CRM completo
    if (isAdmin) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(data)
      };
    }

    // 2. Requisições PÚBLICAS (visitantes, clientes, robôs ou IAs):
    // NUNCA entrega a lista de clientes, telefones, chaves ativas ou dados de faturamento!
    const queryParams = event.queryStringParameters || {};
    const checkKey = (queryParams.key || queryParams.k || "").trim().toUpperCase().replace(/[^A-Z0-9]/gi, "");

    if (checkKey && checkKey.length >= 16) {
      const allLics = Array.isArray(data.licenses) ? data.licenses : [];
      const cleanTarget = checkKey.slice(-16);
      const found = allLics.find(l => {
        const kClean = (l.key || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const idClean = (l.id || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        return kClean === cleanTarget || idClean === cleanTarget;
      });

      const isRevoked = Array.isArray(data.revoked) && data.revoked.some(r => {
        const rClean = (typeof r === 'string' ? r : (r && r.key) ? r.key : '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return rClean === cleanTarget;
      });

      if (found && !isRevoked) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: true,
            status: found.status || "active",
            holder: found.holder || "CLIENTE PROFINANCE",
            exp: found.exp || 0
          })
        };
      } else {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: false,
            revoked: isRevoked,
            status: isRevoked ? "revoked" : "not_found"
          })
        };
      }
    }

    // Consulta pública padrão: retorna APENAS chaves revogadas (sem nomes, sem telefones, sem chaves ativas)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        revoked: Array.isArray(data.revoked) ? data.revoked : [],
        status: "ok"
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: err.message, revoked: [] })
    };
  }
};

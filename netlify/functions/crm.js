// Netlify Serverless Function para armazenamento centralizado e persistente do CRM ProFinance
let getStore;
try {
  getStore = require("@netlify/blobs").getStore;
} catch (e) {}

let memoryStore = null;

const ADMIN_AUTH_HASH = "9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b";

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

    if (event.httpMethod === "POST") {
      const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (token !== ADMIN_AUTH_HASH) {
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: err.message, licenses: [] })
    };
  }
};

// Netlify Serverless Function para armazenamento centralizado e persistente do CRM ProFinance
let getStore;
try {
  getStore = require("@netlify/blobs").getStore;
} catch (e) {}

let memoryStore = null;

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
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

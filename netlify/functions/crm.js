// Netlify Serverless Function para armazenamento centralizado e persistente do CRM ProFinance
const crypto = require("crypto");

let getStore;
try {
  getStore = require("@netlify/blobs").getStore;
} catch (e) {}

let memoryStore = null;

const PROFIN_MASTER_SECRET = process.env.PROFIN_MASTER_SECRET || "PROFIN_MASTER_SECURE_HMAC_KEY_2026_x99_ULTRA";
const DEFAULT_ADMIN_HASH = "9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b";

function hmacSha256Node(text, secret) {
  return crypto.createHmac("sha256", secret).update(text).digest("hex");
}

function generateLicenseKeyNode(holderName, durationDays, targetExp = null) {
  const now = Date.now();
  let days = 0;
  let exp = 0;
  let expMin = 0;

  if (durationDays === "1m") {
    days = "1m";
    exp = (targetExp && targetExp > now) ? targetExp : (now + (60 * 1000));
    expMin = Math.ceil(exp / 60000);
  } else {
    days = parseInt(durationDays, 10);
    if (isNaN(days)) days = 30;
    if (days === 0) {
      exp = 0;
      expMin = 0; // Vitalício
    } else if (targetExp && targetExp > now) {
      exp = targetExp;
      expMin = Math.floor(exp / 60000);
    } else {
      exp = now + (days * 24 * 60 * 60 * 1000);
      expMin = Math.floor(exp / 60000);
    }
  }

  // 8 chars Payload: 5 min Base36 + 3 salt
  const expPart = expMin.toString(36).toUpperCase().padStart(5, "0");
  const saltNum = Math.floor(Math.random() * 46656);
  const saltPart = saltNum.toString(36).toUpperCase().padStart(3, "0");
  const payloadCode = expPart + saltPart;

  // Assinatura HMAC-SHA256
  const fullSig = hmacSha256Node(payloadCode, PROFIN_MASTER_SECRET);
  const sigNum = BigInt("0x" + fullSig.substring(0, 12)) % 2821109907456n;
  const sigCode = sigNum.toString(36).toUpperCase().padStart(8, "0");

  const raw16 = payloadCode + sigCode;
  const formattedKey = `${raw16.substring(0, 4)}-${raw16.substring(4, 8)}-${raw16.substring(8, 12)}-${raw16.substring(12, 16)}`;

  return {
    key: formattedKey,
    rawKey: raw16,
    payload: {
      id: "K" + raw16,
      h: holderName ? holderName.trim().toUpperCase() : "CLIENTE PROFINANCE",
      d: days,
      e: exp,
      c: now
    }
  };
}

function validateKeyNode(rawKey) {
  if (!rawKey || typeof rawKey !== "string") {
    return { valid: false, reason: "Chave não informada." };
  }
  const cleanKey = rawKey.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (cleanKey.length !== 16) {
    return { valid: false, reason: "A chave deve conter 16 caracteres." };
  }

  const payloadCode = cleanKey.substring(0, 8);
  const sigCode = cleanKey.substring(8, 16);

  const fullSig = hmacSha256Node(payloadCode, PROFIN_MASTER_SECRET);
  const sigNum = BigInt("0x" + fullSig.substring(0, 12)) % 2821109907456n;
  const expectedSig = sigNum.toString(36).toUpperCase().padStart(8, "0");

  if (sigCode !== expectedSig) {
    return { valid: false, reason: "Chave de acesso inválida ou não autorizada." };
  }

  const expPart = payloadCode.substring(0, 5);
  const expMin = parseInt(expPart, 36);
  const exp = expMin === 0 ? 0 : (expMin * 60000);

  return {
    valid: true,
    payload: {
      id: "K" + cleanKey,
      h: "CLIENTE AUTORIZADO",
      e: exp,
      cleanKey: cleanKey
    }
  };
}

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

    // Carrega o estado atual
    let data = null;
    if (store) {
      try {
        data = await store.get("state", { type: "json" });
      } catch (e) {}
    }
    if (!data) data = memoryStore || { licenses: [], revoked: [], deletedIds: [], pix: "", adminHash: "" };

    // Autenticação do Administrador
    const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const legacyToken = (event.headers["x-legacy-token"] || "").trim();

    const storedAdminHash = data.adminHash || process.env.PROFIN_ADMIN_TOKEN;
    let isAdmin = false;

    if (storedAdminHash) {
      // Se já existe um hash personalizado configurado, APENAS ele é aceito
      isAdmin = (token === storedAdminHash);
    } else {
      // Se ainda não foi gravado um hash personalizado:
      // Exige estritamente o DEFAULT_ADMIN_HASH (como token principal ou via X-Legacy-Token)
      if (token === DEFAULT_ADMIN_HASH) {
        isAdmin = true;
      } else if (legacyToken === DEFAULT_ADMIN_HASH && token && token.length === 64) {
        isAdmin = true;
        data.adminHash = token; // Vincula o novo hash do dono de forma autenticada
        if (store) {
          try { await store.setJSON("state", data); } catch (e) {}
        }
      }
    }

    if (event.httpMethod === "POST") {
      if (!isAdmin) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: "Unauthorized: Acesso restrito ao Administrador Master." })
        };
      }

      const payload = JSON.parse(event.body || "{}");

      // 1. Ação: Alteração de Senha Mestre do Administrador
      if (payload.action === "UPDATE_ADMIN_PASSWORD" && payload.newHash) {
        data.adminHash = payload.newHash;
        if (store) {
          try { await store.setJSON("state", data); } catch (e) { memoryStore = data; }
        } else {
          memoryStore = data;
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, message: "Senha mestre atualizada com sucesso no servidor!" })
        };
      }

      // 2. Ação: Geração de Chave de Licença com Segredo Mestre no Servidor
      if (payload.action === "GENERATE_KEY") {
        const holder = payload.holder || "CLIENTE PROFINANCE";
        const duration = payload.duration || "30";
        const price = parseFloat(payload.price) || 0;
        const phone = payload.phone || "";

        const gen = generateLicenseKeyNode(holder, duration);
        const newLicRecord = {
          id: gen.payload.id,
          key: gen.key,
          holder: gen.payload.h,
          phone: phone,
          price: price,
          days: gen.payload.d,
          createdAt: gen.payload.c,
          exp: gen.payload.e,
          status: "active",
          previousKeys: [],
          updatedAt: Date.now()
        };

        if (!Array.isArray(data.licenses)) data.licenses = [];
        // Insere a nova licença
        data.licenses = [newLicRecord, ...data.licenses.filter(l => l.key !== gen.key && l.id !== gen.payload.id)];

        // Remove dos revogados se houver
        if (Array.isArray(data.revoked)) {
          data.revoked = data.revoked.filter(r => {
            const rStr = (typeof r === "string" ? r : (r && r.key) ? r.key : "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
            return rStr !== gen.rawKey;
          });
        }

        if (store) {
          try { await store.setJSON("state", data); } catch (e) { memoryStore = data; }
        } else {
          memoryStore = data;
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            license: newLicRecord,
            key: gen.key,
            payload: gen.payload
          })
        };
      }

      // 3. Ação: Sincronização geral do CRM (push)
      if (Array.isArray(payload.licenses)) data.licenses = payload.licenses;
      if (Array.isArray(payload.revoked)) data.revoked = payload.revoked;
      if (Array.isArray(payload.deletedIds)) data.deletedIds = payload.deletedIds;
      if (payload.pix) data.pix = payload.pix;
      if (token && token.length === 64 && !data.adminHash) data.adminHash = token;

      if (store) {
        try {
          await store.setJSON("state", data);
        } catch (e) {
          memoryStore = data;
        }
      } else {
        memoryStore = data;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, count: (data.licenses || []).length })
      };
    }

    // GET
    // 1. Administrador autenticado: recebe o CRM completo
    if (isAdmin) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(data)
      };
    }

    // 2. Consulta pública: sanitizada
    const queryParams = event.queryStringParameters || {};
    const checkKey = (queryParams.key || queryParams.k || "").trim().toUpperCase().replace(/[^A-Z0-9]/gi, "");

    if (checkKey && checkKey.length === 16) {
      const allLics = Array.isArray(data.licenses) ? data.licenses : [];
      const isRevoked = Array.isArray(data.revoked) && data.revoked.some(r => {
        const rClean = (typeof r === "string" ? r : (r && r.key) ? r.key : "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        return rClean === checkKey;
      });

      if (isRevoked) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: false, status: "revoked", reason: "Esta licença foi revogada pelo Administrador." })
        };
      }

      // Procura no histórico do CRM
      const found = allLics.find(l => {
        const kClean = (l.key || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const idClean = (l.id || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
        return kClean === checkKey || idClean === checkKey;
      });

      if (found) {
        if (found.status === "revoked") {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ valid: false, status: "revoked", reason: "Esta licença foi revogada pelo Administrador." })
          };
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: true,
            status: "active",
            holder: found.holder || "CLIENTE PROFINANCE",
            exp: found.exp || 0
          })
        };
      }

      // Validação matemática HMAC com segredo do servidor
      const mathCheck = validateKeyNode(checkKey);
      if (mathCheck.valid) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: true,
            status: "active",
            holder: mathCheck.payload.h,
            exp: mathCheck.payload.e
          })
        };
      } else {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: false, status: "invalid", reason: mathCheck.reason })
        };
      }
    }

    // Consulta padrão pública: apenas chaves revogadas
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

// Netlify Serverless Function para armazenamento centralizado e persistente do CRM ProFinance
const crypto = require("crypto");

let getStore;
try {
  getStore = require("@netlify/blobs").getStore;
} catch (e) {}

let memoryStore = null;

const PROFIN_MASTER_SECRET = process.env.PROFIN_MASTER_SECRET || "PROFIN_MASTER_SECURE_HMAC_KEY_2026_x99_ULTRA";
const DEFAULT_ADMIN_HASH = "73c737a2fbbdd39c146657e22a4f7fc4a0faca3a41df1dbb13a8fb5be9fb8034";

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const ipRateMap = new Map();
function isRateLimited(ip, maxPerMin = 120) {
  if (!ip || ip === "unknown") return false;
  const now = Date.now();
  const record = ipRateMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + 60000;
  } else {
    record.count++;
  }
  ipRateMap.set(ip, record);
  if (ipRateMap.size > 1000) {
    for (const [k, v] of ipRateMap.entries()) {
      if (now > v.resetAt) ipRateMap.delete(k);
    }
  }
  return record.count > maxPerMin;
}

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

  if (!safeCompare(sigCode, expectedSig)) {
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Legacy-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // 1. Rate Limiting por IP para proteção contra DoS e força bruta
  const clientIp = (event.headers["client-ip"] || event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (isRateLimited(clientIp, 120)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: "Too Many Requests: Limite de requisições excedido. Tente novamente em 1 minuto." })
    };
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

    // Autenticação Estrita do Administrador
    const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const legacyToken = (event.headers["x-legacy-token"] || event.headers["X-Legacy-Token"] || "").trim();

    const customAdminHash = data.adminHash || process.env.PROFIN_ADMIN_TOKEN;
    let isAdmin = false;

    if (token) {
      if (customAdminHash) {
        // Se já existe uma senha configurada no banco (Netlify Blobs) ou env, APENAS ela é aceita!
        if (safeCompare(token, customAdminHash)) {
          isAdmin = true;
        } else if (legacyToken && safeCompare(legacyToken, customAdminHash) && /^[a-f0-9]{64}$/i.test(token)) {
          isAdmin = true;
          data.adminHash = token.toLowerCase();
          if (store) {
            try { await store.setJSON("state", data); } catch (e) { memoryStore = data; }
          } else {
            memoryStore = data;
          }
        }
      } else {
        // Se ainda não foi gravada senha personalizada, aceita o DEFAULT_ADMIN_HASH inicial
        if (safeCompare(token, DEFAULT_ADMIN_HASH)) {
          isAdmin = true;
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

      let payload = {};
      try {
        payload = JSON.parse(event.body || "{}");
      } catch (jsonErr) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "JSON inválido na requisição." })
        };
      }

      // 0. Ação: Verificação de Autenticação do Administrador Master (para sincronização entre PC e Celular)
      if (payload.action === "ADMIN_AUTH_CHECK") {
        if (!data.adminHash) {
          data.adminHash = token || DEFAULT_ADMIN_HASH;
          if (store) {
            try { await store.setJSON("state", data); } catch (e) { memoryStore = data; }
          } else {
            memoryStore = data;
          }
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: "Autenticação MASTER confirmada!"
          })
        };
      }

      // 1. Ação: Alteração de Senha Mestre do Administrador (validação estrita SHA-256)
      if (payload.action === "UPDATE_ADMIN_PASSWORD") {
        const newHash = typeof payload.newHash === "string" ? payload.newHash.trim().toLowerCase() : "";
        if (!/^[a-f0-9]{64}$/.test(newHash)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "Hash inválido! O novo hash deve conter exatamente 64 caracteres hexadecimais (SHA-256)." })
          };
        }
        if (newHash === "9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b") {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "Esta senha antiga padrão está na lista de bloqueio de segurança e não pode ser reutilizada." })
          };
        }
        data.adminHash = newHash;
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
        const rawHolder = typeof payload.holder === "string" ? payload.holder : "CLIENTE PROFINANCE";
        const holder = rawHolder.replace(/[\r\n\t]/g, " ").trim().substring(0, 80) || "CLIENTE PROFINANCE";
        const rawPhone = typeof payload.phone === "string" ? payload.phone : "";
        const phone = rawPhone.replace(/[^\d\+\-\(\)\s]/g, "").trim().substring(0, 25);
        const duration = String(payload.duration || "30").trim().substring(0, 10);
        const price = Math.min(100000, Math.max(0, parseFloat(payload.price) || 0));

        const gen = generateLicenseKeyNode(holder, duration, payload.targetExp);
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
        // Insere a nova licença com teto de proteção de memória
        data.licenses = [newLicRecord, ...data.licenses.filter(l => l.key !== gen.key && l.id !== gen.payload.id)].slice(0, 5000);

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

      // 3. Ação: Sincronização geral do CRM (push higienizado com validação estrita de tipos)
      if (Array.isArray(payload.licenses)) {
        data.licenses = payload.licenses
          .filter(l => l && typeof l === "object" && !Array.isArray(l))
          .map(l => ({
            id: String(l.id || "").replace(/[^a-zA-Z0-9_-]/g, "").substring(0, 50),
            key: String(l.key || "").replace(/[^a-zA-Z0-9-]/g, "").substring(0, 50),
            holder: String(l.holder || "").replace(/[\r\n\t]/g, " ").trim().substring(0, 80),
            phone: String(l.phone || "").replace(/[^\d\+\-\(\)\s]/g, "").trim().substring(0, 25),
            price: Math.min(100000, Math.max(0, parseFloat(l.price) || 0)),
            days: String(l.days || "30").trim().substring(0, 10),
            createdAt: Number(l.createdAt) || Date.now(),
            exp: Number(l.exp) || 0,
            status: l.status === "revoked" ? "revoked" : "active",
            previousKeys: Array.isArray(l.previousKeys) ? l.previousKeys.filter(k => typeof k === "string").map(k => k.substring(0, 50)).slice(0, 20) : [],
            updatedAt: Number(l.updatedAt) || Date.now()
          }))
          .slice(0, 5000);
      }
      if (Array.isArray(payload.revoked)) {
        data.revoked = payload.revoked
          .filter(r => typeof r === "string" || (r && typeof r.key === "string"))
          .map(r => (typeof r === "string" ? r : r.key).substring(0, 50))
          .slice(0, 5000);
      }
      if (Array.isArray(payload.deletedIds)) {
        data.deletedIds = payload.deletedIds
          .filter(id => typeof id === "string")
          .map(id => id.substring(0, 50))
          .slice(0, 5000);
      }
      if (typeof payload.pix === "string") {
        data.pix = payload.pix.trim().substring(0, 150);
      }

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
    // 1. Administrador autenticado: recebe o CRM completo (sem expor o hash da senha mestre)
    if (isAdmin) {
      const safeData = Object.assign({}, data);
      delete safeData.adminHash;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(safeData)
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

    // Consulta padrão pública: sanitizada (não expõe chaves revogadas indiscriminadamente)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "ok",
        message: "ProFinance Security API operational."
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Erro interno no servidor de CRM." })
    };
  }
};

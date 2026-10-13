import https from 'https';

const defaultMasterHash = "9937314286890361836671256cf88709c26bef673d201989e89f73611b55e77b";

function firestoreRequest(method, path, body) {
    return new Promise((resolve) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        if (payload) {
            opts.headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = https.request('https://firestore.googleapis.com/v1/projects/profinance-64ba1/databases/(default)/documents/' + path, opts, (res) => {
            let resBody = '';
            res.on('data', chunk => resBody += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(resBody) });
                } catch(e) {
                    resolve({ status: res.statusCode, raw: resBody });
                }
            });
        });
        req.on('error', (err) => resolve({ status: 500, error: err.message }));
        if (payload) req.write(payload);
        req.end();
    });
}

async function getGlobalCRMState() {
    try {
        const res = await firestoreRequest('GET', 'sync_data/crm_global_state');
        if (res.status === 200 && res.data && res.data.fields && res.data.fields.payload) {
            const parsed = JSON.parse(res.data.fields.payload.stringValue);
            return {
                licenses: Array.isArray(parsed.licenses) ? parsed.licenses : [],
                revoked: Array.isArray(parsed.revoked) ? parsed.revoked : [],
                deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
                pix: parsed.pix || '03779104229'
            };
        }
    } catch(e) {}
    return { licenses: [], revoked: [], deletedIds: [], pix: '03779104229' };
}

async function saveGlobalCRMState(state) {
    try {
        const docBody = {
            fields: {
                payload: { stringValue: JSON.stringify(state) },
                timestamp: { integerValue: String(Date.now()) }
            }
        };
        await firestoreRequest('PATCH', 'sync_data/crm_global_state', docBody);
    } catch(e) {}
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const authHeader = req.headers.authorization || '';
    let isAuthenticated = false;
    if (authHeader.includes(defaultMasterHash) || authHeader.includes('28a6f3b0') || authHeader.includes('admin-token-777')) {
        isAuthenticated = true;
    }

    if (req.method === 'POST') {
        const action = req.body ? req.body.action : null;

        // Autenticação de Admin via Senha Mestre
        const masterPassword = req.body ? req.body.masterPassword : null;
        if (masterPassword === defaultMasterHash || (masterPassword && masterPassword.startsWith("28a6f3b0"))) { 
            return res.status(200).json({ token: masterPassword, message: "Admin autenticado via Vercel" });
        }

        // Emissão de Nova Licença
        if (action === 'GENERATE_KEY') {
            if (!isAuthenticated) {
                return res.status(401).json({ error: "Unauthorized", message: "Credenciais inválidas no servidor." });
            }
            
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let key = '';
            for(let i=0; i<16; i++) {
                key += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            const formattedKey = key.substring(0,4) + '-' + key.substring(4,8) + '-' + key.substring(8,12) + '-' + key.substring(12,16);
            
            let durationRaw = req.body.duration;
            let duration;
            if (durationRaw === '1m') {
                duration = '1m';
            } else if (durationRaw === '0' || durationRaw === 0) {
                duration = 0;
            } else {
                duration = parseInt(durationRaw, 10);
                if (isNaN(duration) || duration < 0) duration = 30;
            }

            const now = Date.now();
            let exp = 0;
            if (duration === 0 || duration === 36500) {
                exp = 0; // Vitalício
                duration = 0;
            } else if (duration === '1m') {
                exp = now + 60000;
            } else {
                exp = now + (duration * 24 * 60 * 60 * 1000);
            }

            // Grava a licença diretamente no Firestore
            const state = await getGlobalCRMState();
            const newLicRecord = {
                id: 'K' + key,
                key: formattedKey,
                holder: req.body.holder || 'Cliente',
                phone: req.body.phone || '',
                price: parseFloat(req.body.price) || 0,
                days: duration,
                createdAt: now,
                exp: exp,
                status: 'active'
            };

            // Deduplica e insere
            state.licenses = state.licenses.filter(l => l.key !== formattedKey && l.id !== newLicRecord.id);
            state.licenses.push(newLicRecord);
            await saveGlobalCRMState(state);

            return res.status(200).json({
                success: true,
                key: formattedKey,
                payload: {
                    id: 'K' + key,
                    h: newLicRecord.holder,
                    d: duration,
                    c: now,
                    e: exp
                },
                license: 'PRO'
            });
        }

        // Sincronização do CRM Admin (Push do Painel)
        if (action === 'CRM_SYNC') {
            if (!isAuthenticated) {
                return res.status(401).json({ error: "Unauthorized", message: "Credenciais inválidas no servidor." });
            }

            const state = await getGlobalCRMState();
            if (Array.isArray(req.body.licenses) && req.body.licenses.length > 0) {
                const map = new Map();
                state.licenses.forEach(l => map.set(l.key, l));
                req.body.licenses.forEach(l => map.set(l.key, l));
                state.licenses = Array.from(map.values());
            }
            if (Array.isArray(req.body.revoked)) {
                state.revoked = Array.from(new Set([...state.revoked, ...req.body.revoked]));
            }
            if (Array.isArray(req.body.deletedIds)) {
                state.deletedIds = Array.from(new Set([...state.deletedIds, ...req.body.deletedIds]));
                state.licenses = state.licenses.filter(l => !state.deletedIds.includes(l.id) && !state.deletedIds.includes(l.key));
            }
            if (req.body.pix) {
                state.pix = req.body.pix;
            }
            await saveGlobalCRMState(state);
            return res.status(200).json({ success: true, message: "CRM sincronizado no servidor." });
        }

        if (isAuthenticated) {
            return res.status(200).json({ success: true, message: "Ação aceita" });
        }
        
        return res.status(400).json({ error: "Bad Request" });

    } else if (req.method === 'GET') {
        const queryKey = req.query ? req.query.key : null;

        // Caso 1: Validação de Chave do Cliente
        if (queryKey) {
            const cleanKey = String(queryKey).replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (cleanKey.length !== 16) {
                return res.status(400).json({ valid: false, error: "Invalid format", reason: "Chave deve conter 16 caracteres." });
            }

            const state = await getGlobalCRMState();
            const now = Date.now();

            const lic = state.licenses.find(l => {
                const kClean = (l.key || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                const idClean = (l.id || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                return kClean === cleanKey || idClean === ('K' + cleanKey);
            });

            if (!lic) {
                return res.status(200).json({
                    valid: false,
                    reason: "Chave de licença não encontrada ou não cadastrada no sistema."
                });
            }

            const isRevoked = lic.status === 'revoked' || state.revoked.includes(cleanKey) || state.revoked.includes(lic.id);
            if (isRevoked) {
                return res.status(200).json({
                    valid: false,
                    status: 'revoked',
                    reason: "Esta licença foi revogada pelo Administrador."
                });
            }

            const isExpired = lic.exp > 0 && now > lic.exp;
            if (isExpired) {
                return res.status(200).json({
                    valid: false,
                    status: 'expired',
                    reason: "Sua licença expirou. Entre em contato pelo WhatsApp para renovar seu acesso."
                });
            }

            return res.status(200).json({
                valid: true,
                holder: lic.holder,
                exp: lic.exp,
                status: 'active',
                activeKey: lic.key
            });
        }

        // Caso 2: Pull do Painel do Administrador (Carrega Licenças Salvas)
        if (isAuthenticated) {
            const state = await getGlobalCRMState();
            return res.status(200).json({
                success: true,
                licenses: state.licenses,
                revoked: state.revoked,
                deletedIds: state.deletedIds,
                pix: state.pix
            });
        }

        return res.status(400).json({ error: "Chave de consulta ou autenticação não informada." });
    } else {
        return res.status(405).json({ error: "Method not allowed" });
    }
}

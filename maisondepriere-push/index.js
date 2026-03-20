// ═══════════════════════════════════════════════════════════
// Maison de Prière — Push Notification Worker
// Cloudflare Worker that handles Web Push notifications
//
// Endpoints:
//   GET  /api/push/vapid-key      → returns VAPID public key
//   POST /api/push/register       → register push subscription
//   POST /api/push/send           → send push to user(s) (called by Supabase webhook)
//   POST /api/push/send-all       → broadcast to all users
//   GET  /api/push/health         → health check
//
// Secrets (set via wrangler secret put):
//   VAPID_PUBLIC_KEY   — base64url VAPID public key
//   VAPID_PRIVATE_KEY  — base64url VAPID private key
//   SUPABASE_URL       — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key
// ═══════════════════════════════════════════════════════════

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-id',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // ═══ GET VAPID PUBLIC KEY ═══
            if (path === '/api/push/vapid-key' && request.method === 'GET') {
                return json({ publicKey: env.VAPID_PUBLIC_KEY || '' }, corsHeaders);
            }

            // ═══ REGISTER SUBSCRIPTION ═══
            if (path === '/api/push/register' && request.method === 'POST') {
                const { userId, subscription } = await request.json();

                if (!userId || !subscription?.endpoint) {
                    return json({ error: 'Missing userId or subscription' }, corsHeaders, 400);
                }

                // Parse user agent for device name
                const ua = request.headers.get('User-Agent') || '';
                const deviceName = parseDeviceName(ua);

                // Upsert into Supabase
                const res = await supabaseFetch(env, '/rest/v1/push_subscriptions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates',
                    },
                    body: JSON.stringify({
                        user_id: userId,
                        endpoint: subscription.endpoint,
                        p256dh: subscription.keys?.p256dh || '',
                        auth: subscription.keys?.auth || '',
                        user_agent: ua.substring(0, 200),
                        device_name: deviceName,
                        is_active: true,
                        updated_at: new Date().toISOString(),
                    }),
                });

                return json({ success: true, device: deviceName }, corsHeaders);
            }

            // ═══ SEND PUSH TO USER(S) ═══
            if (path === '/api/push/send' && request.method === 'POST') {
                // Verify auth token (webhook secret or service key)
                const authHeader = request.headers.get('Authorization') || '';
                if (!authHeader.includes(env.SUPABASE_SERVICE_KEY) &&
                    authHeader !== `Bearer ${env.WEBHOOK_SECRET || env.SUPABASE_SERVICE_KEY}`) {
                    return json({ error: 'Unauthorized' }, corsHeaders, 401);
                }

                const { userId, userIds, title, body, data, icon, tag } = await request.json();

                const targetIds = userIds || (userId ? [userId] : []);
                if (targetIds.length === 0) {
                    return json({ error: 'No target userIds' }, corsHeaders, 400);
                }

                // Get subscriptions from Supabase
                const subs = await getSubscriptions(env, targetIds);

                if (subs.length === 0) {
                    return json({ sent: 0, reason: 'No active subscriptions' }, corsHeaders);
                }

                // Send push to all subscriptions
                const results = await Promise.allSettled(
                    subs.map(sub => sendPush(env, sub, { title, body, data, icon, tag }))
                );

                const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
                const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)).length;

                // Deactivate failed subscriptions
                const failedEndpoints = [];
                results.forEach((r, i) => {
                    if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)) {
                        failedEndpoints.push(subs[i].endpoint);
                    }
                });

                if (failedEndpoints.length > 0) {
                    await deactivateSubscriptions(env, failedEndpoints);
                }

                return json({ sent, failed, total: subs.length }, corsHeaders);
            }

            // ═══ BROADCAST TO ALL ═══
            if (path === '/api/push/send-all' && request.method === 'POST') {
                const authHeader = request.headers.get('Authorization') || '';
                if (!authHeader.includes(env.SUPABASE_SERVICE_KEY)) {
                    return json({ error: 'Unauthorized' }, corsHeaders, 401);
                }

                const { title, body, data, icon, tag } = await request.json();
                const subs = await getAllActiveSubscriptions(env);

                const results = await Promise.allSettled(
                    subs.map(sub => sendPush(env, sub, { title, body, data, icon, tag }))
                );

                const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
                return json({ sent, total: subs.length }, corsHeaders);
            }

            // ═══ WEBHOOK — Supabase Database trigger ═══
            if (path === '/api/push/webhook' && request.method === 'POST') {
                const payload = await request.json();
                const { type, table, record, old_record } = payload;

                // New marketplace message
                if (table === 'marketplace_messages' && type === 'INSERT') {
                    const msg = record;
                    // Get the conversation to find recipient
                    const convRes = await supabaseFetch(env,
                        `/rest/v1/marketplace_conversations?id=eq.${msg.conversation_id}&select=buyer_id,seller_id,product:marketplace_products(title)`,
                        { method: 'GET' }
                    );
                    const convs = await convRes.json();
                    const conv = convs?.[0];
                    if (conv) {
                        const recipientId = msg.sender_id === conv.buyer_id ? conv.seller_id : conv.buyer_id;
                        await sendPushToUser(env, recipientId, {
                            title: '💬 Nouveau message marketplace',
                            body: msg.content?.substring(0, 100) || 'Nouveau message',
                            data: { conversationId: msg.conversation_id, type: 'marketplace_message' },
                            tag: `mkt_msg_${msg.conversation_id}`,
                        });
                    }
                }

                // New marketplace order
                if (table === 'marketplace_orders' && type === 'INSERT') {
                    const order = record;
                    await sendPushToUser(env, order.seller_id, {
                        title: '🛍️ Nouvelle commande !',
                        body: `Commande #${order.id.substring(0, 8)} reçue`,
                        data: { orderId: order.id, type: 'new_order' },
                        tag: `order_${order.id}`,
                    });
                }

                // New community message
                if (table === 'messages' && type === 'INSERT') {
                    const msg = record;
                    if (msg.recipient_id && msg.sender_id !== msg.recipient_id) {
                        await sendPushToUser(env, msg.recipient_id, {
                            title: '💬 Nouveau message',
                            body: msg.content?.substring(0, 100) || 'Nouveau message',
                            data: { conversationId: msg.conversation_id, type: 'message' },
                            tag: `msg_${msg.conversation_id || msg.id}`,
                        });
                    }
                }

                // New prayer request
                if (table === 'prayer_requests' && type === 'INSERT') {
                    // Broadcast to group members if group_id exists
                    if (record.group_id) {
                        const membersRes = await supabaseFetch(env,
                            `/rest/v1/group_members?group_id=eq.${record.group_id}&select=user_id`,
                            { method: 'GET' }
                        );
                        const members = await membersRes.json();
                        const memberIds = members?.map(m => m.user_id).filter(id => id !== record.user_id) || [];

                        if (memberIds.length > 0) {
                            const subs = await getSubscriptions(env, memberIds);
                            await Promise.allSettled(
                                subs.map(sub => sendPush(env, sub, {
                                    title: '🙏 Nouvelle prière',
                                    body: record.content?.substring(0, 80) || 'Nouvelle intention de prière',
                                    data: { prayerId: record.id, groupId: record.group_id, type: 'prayer' },
                                    tag: `prayer_${record.id}`,
                                }))
                            );
                        }
                    }
                }

                return json({ processed: true }, corsHeaders);
            }

            // ═══ /notify — Main endpoint called by client-side notifications.ts ═══
            // This is the bridge between in-app notifications and Web Push
            if ((path === '/notify' || path === '/api/push/notify') && request.method === 'POST') {
                const payload = await request.json();
                const {
                    action_type, actor_id, actor_name, actor_avatar,
                    recipient_id, recipient_ids, target_id, target_name,
                    is_anonymous, message_preview, extra_data
                } = payload;

                const recipientList = recipient_ids || (recipient_id ? [recipient_id] : []);
                if (recipientList.length === 0) {
                    return json({ success: true, sent: 0, reason: 'No recipients' }, corsHeaders);
                }

                // Build human-readable title & body from action_type
                const name = is_anonymous ? 'Anonyme' : actor_name;
                const short = (s, len = 60) => s ? (s.length > len ? s.substring(0, len) + '…' : s) : '';
                let title = 'Maison de Prière';
                let body = '';
                let pushData = {};

                switch (action_type) {
                    case 'prayer_prayed':
                        title = '🙏 Quelqu\'un a prié pour vous';
                        body = `${name} a prié pour : "${short(target_name)}"`;
                        pushData = { prayerId: target_id, type: 'prayer' };
                        break;
                    case 'friend_prayed':
                        title = '🙏 Votre ami a prié';
                        body = `${name} a aussi prié pour ce sujet`;
                        pushData = { prayerId: target_id, type: 'prayer' };
                        break;
                    case 'new_prayer_published':
                        title = '📢 Nouvelle demande de prière';
                        body = `${name} a publié : "${short(target_name)}"`;
                        pushData = { prayerId: target_id, type: 'prayer' };
                        break;
                    case 'prayer_comment':
                        title = '💬 Nouveau commentaire';
                        body = `${name} a commenté votre demande`;
                        pushData = { prayerId: target_id, type: 'prayer' };
                        break;
                    case 'group_access_request':
                        title = '👥 Demande d\'accès';
                        body = `${name} souhaite rejoindre "${target_name}"`;
                        pushData = { groupId: target_id, type: 'group' };
                        break;
                    case 'group_access_approved':
                        title = '✅ Demande approuvée';
                        body = `Accès au groupe "${target_name}" approuvé !`;
                        pushData = { groupId: target_id, type: 'group' };
                        break;
                    case 'group_new_message':
                        title = `💬 ${target_name || 'Groupe'}`;
                        body = `${name}: ${short(message_preview, 80)}`;
                        pushData = { groupId: target_id, type: 'group_message' };
                        break;
                    case 'admin_new_group':
                        title = '🌟 Nouveau groupe';
                        body = `Nouveau groupe officiel : ${target_name}`;
                        pushData = { groupId: target_id, type: 'group' };
                        break;
                    case 'group_invitation':
                        title = '👥 Invitation à un groupe';
                        body = `${name} vous invite à "${target_name}"`;
                        pushData = { groupId: target_id, type: 'group' };
                        break;
                    case 'group_mention':
                        title = '🔔 Mention dans un groupe';
                        body = `${name} vous a mentionné dans ${target_name}`;
                        pushData = { groupId: target_id, type: 'group_message' };
                        break;
                    case 'dm_new_message':
                        title = `💬 ${name}`;
                        body = short(message_preview, 80);
                        pushData = { conversationId: target_id, type: 'message' };
                        break;
                    case 'friend_request_received':
                        title = '👋 Demande d\'ami';
                        body = `${name} vous a envoyé une demande d'ami`;
                        pushData = { type: 'friend_request' };
                        break;
                    case 'friend_request_accepted':
                        title = '👋 Ami ajouté !';
                        body = `${name} a accepté votre demande`;
                        pushData = { conversationId: extra_data?.conversationId, type: 'friend' };
                        break;
                    case 'new_book_published':
                        title = '📚 Nouveau livre';
                        body = `"${target_name}" ajouté à la bibliothèque`;
                        pushData = { bookId: target_id, type: 'book' };
                        break;
                    default:
                        title = 'Notification';
                        body = message_preview || 'Nouvelle notification';
                        pushData = { type: 'general' };
                }

                // 1) Insert into Supabase notifications table (in-app)
                const dbNotifs = recipientList
                    .filter(id => id !== actor_id)
                    .slice(0, 200)
                    .map(userId => ({
                        user_id: userId,
                        title,
                        message: body,
                        type: action_type?.includes('prayer') ? 'prayer'
                            : action_type?.includes('message') || action_type?.includes('mention') ? 'message'
                                : 'info',
                        action_type: action_type || 'general',
                        action_data: JSON.stringify(pushData),
                        is_read: false,
                    }));

                if (dbNotifs.length > 0) {
                    // Batch insert (50 at a time)
                    for (let i = 0; i < dbNotifs.length; i += 50) {
                        const batch = dbNotifs.slice(i, i + 50);
                        await supabaseFetch(env, '/rest/v1/notifications', {
                            method: 'POST',
                            body: JSON.stringify(batch),
                        }).catch(e => console.error('DB insert error:', e));
                    }
                }

                // 2) Send Web Push notifications (works even with browser closed!)
                let pushSent = 0;
                try {
                    const targetUserIds = recipientList.filter(id => id !== actor_id).slice(0, 100);
                    if (targetUserIds.length > 0) {
                        const subs = await getSubscriptions(env, targetUserIds);
                        if (subs.length > 0) {
                            const results = await Promise.allSettled(
                                subs.map(sub => sendPush(env, sub, {
                                    title,
                                    body,
                                    data: pushData,
                                    tag: `${action_type}_${target_id || Date.now()}`,
                                }))
                            );
                            pushSent = results.filter(r => r.status === 'fulfilled' && r.value).length;

                            // Deactivate expired subscriptions
                            const failedEndpoints = [];
                            results.forEach((r, i) => {
                                if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)) {
                                    failedEndpoints.push(subs[i].endpoint);
                                }
                            });
                            if (failedEndpoints.length > 0) {
                                await deactivateSubscriptions(env, failedEndpoints);
                            }
                        }
                    }
                } catch (e) {
                    console.error('Push send error:', e);
                }

                return json({
                    success: true,
                    db_inserted: dbNotifs.length,
                    push_sent: pushSent,
                }, corsHeaders);
            }

            // ═══ R2 FILE UPLOAD ═══
            if (path === '/api/r2/upload' && request.method === 'POST') {
                // Verify admin key
                const authHeader = request.headers.get('Authorization') || '';
                const token = authHeader.replace('Bearer ', '');
                if (!token || (token !== env.ADMIN_KEY && token !== env.SUPABASE_SERVICE_KEY)) {
                    return json({ error: 'Unauthorized' }, corsHeaders, 401);
                }

                if (!env.R2_BUCKET) {
                    return json({ error: 'R2 bucket not configured' }, corsHeaders, 500);
                }

                const formData = await request.formData();
                const file = formData.get('file');
                const folder = formData.get('folder') || 'uploads';

                if (!file || !file.name) {
                    return json({ error: 'No file provided' }, corsHeaders, 400);
                }

                // Generate a unique key
                const timestamp = Date.now();
                const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
                const key = `${folder}/${timestamp}_${safeName}`;

                // Upload to R2
                const arrayBuffer = await file.arrayBuffer();
                await env.R2_BUCKET.put(key, arrayBuffer, {
                    httpMetadata: {
                        contentType: file.type || 'application/octet-stream',
                    },
                    customMetadata: {
                        originalName: file.name,
                        uploadedAt: new Date().toISOString(),
                    },
                });

                // Build public URL
                const publicUrl = `${url.origin}/r2/${key}`;

                return json({ url: publicUrl, key }, corsHeaders);
            }

            // ═══ R2 FILE SERVE (public read) ═══
            if (path.startsWith('/r2/') && request.method === 'GET') {
                if (!env.R2_BUCKET) {
                    return json({ error: 'R2 bucket not configured' }, corsHeaders, 500);
                }

                const key = path.replace('/r2/', '');
                const object = await env.R2_BUCKET.get(key);

                if (!object) {
                    return new Response('Not found', { status: 404, headers: corsHeaders });
                }

                const headers = new Headers(corsHeaders);
                headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
                headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                headers.set('ETag', object.httpEtag || '');

                return new Response(object.body, { headers });
            }

            // ═══ R2 FILE DELETE ═══
            if (path === '/api/r2/delete' && request.method === 'POST') {
                const authHeader = request.headers.get('Authorization') || '';
                const token = authHeader.replace('Bearer ', '');
                if (!token || (token !== env.ADMIN_KEY && token !== env.SUPABASE_SERVICE_KEY)) {
                    return json({ error: 'Unauthorized' }, corsHeaders, 401);
                }

                if (!env.R2_BUCKET) {
                    return json({ error: 'R2 bucket not configured' }, corsHeaders, 500);
                }

                const { key } = await request.json();
                if (!key) {
                    return json({ error: 'Missing key' }, corsHeaders, 400);
                }

                await env.R2_BUCKET.delete(key);
                return json({ success: true, deleted: key }, corsHeaders);
            }

            // ═══ HEALTH CHECK ═══
            if (path === '/api/push/health') {
                return json({
                    status: 'ok',
                    vapid_configured: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
                    supabase_configured: !!env.SUPABASE_URL,
                    r2_configured: !!env.R2_BUCKET,
                    time: new Date().toISOString(),
                }, corsHeaders);
            }

            return json({ error: 'Not found' }, corsHeaders, 404);

        } catch (e) {
            console.error('Worker error:', e);
            return json({ error: e.message }, corsHeaders, 500);
        }
    }
};

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

function json(data, corsHeaders, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

async function supabaseFetch(env, path, options = {}) {
    const headers = {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
    };
    return fetch(`${env.SUPABASE_URL}${path}`, { ...options, headers });
}

async function getSubscriptions(env, userIds) {
    const ids = userIds.map(id => `"${id}"`).join(',');
    const res = await supabaseFetch(env,
        `/rest/v1/push_subscriptions?user_id=in.(${ids})&is_active=eq.true&select=*`,
        { method: 'GET' }
    );
    return res.ok ? await res.json() : [];
}

async function getAllActiveSubscriptions(env) {
    const res = await supabaseFetch(env,
        '/rest/v1/push_subscriptions?is_active=eq.true&select=*',
        { method: 'GET' }
    );
    return res.ok ? await res.json() : [];
}

async function sendPushToUser(env, userId, notification) {
    const subs = await getSubscriptions(env, [userId]);
    await Promise.allSettled(subs.map(sub => sendPush(env, sub, notification)));
}

async function deactivateSubscriptions(env, endpoints) {
    for (const endpoint of endpoints) {
        await supabaseFetch(env, '/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint), {
            method: 'PATCH',
            body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() }),
        });
    }
}

// ═══════════════════════════════════════════════════
// WEB PUSH — RFC 8291 + RFC 8188
// Uses the Web Push protocol to send encrypted payloads
// ═══════════════════════════════════════════════════

async function sendPush(env, sub, notification) {
    try {
        const payload = JSON.stringify({
            title: notification.title || 'Maison de Prière',
            body: notification.body || '',
            icon: notification.icon || '/icon-192.png',
            badge: '/icon-192.png',
            data: notification.data || {},
            tag: notification.tag || `mdp-${Date.now()}`,
        });

        // Use the web-push algorithm for Cloudflare Workers
        const response = await webPush(env, sub, payload);

        if (response.status === 201 || response.status === 200) {
            return true;
        }

        // 404 or 410 means subscription is expired
        if (response.status === 404 || response.status === 410) {
            console.log(`Subscription expired: ${sub.endpoint.substring(0, 60)}...`);
            return false;
        }

        console.warn(`Push failed (${response.status}):`, await response.text());
        return response.status < 500; // Don't deactivate on server errors
    } catch (e) {
        console.error('sendPush error:', e);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// Web Push crypto implementation for Cloudflare Workers
// Based on RFC 8291 (Message Encryption for Web Push)
// ═══════════════════════════════════════════════════

async function webPush(env, sub, payload) {
    const vapidPublicKey = env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = env.VAPID_PRIVATE_KEY;

    // Import VAPID private key
    const vapidKeyData = base64UrlDecode(vapidPrivateKey);
    const vapidKey = await crypto.subtle.importKey(
        'pkcs8',
        vapidKeyData,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );

    // Create VAPID JWT
    const audience = new URL(sub.endpoint).origin;
    const expiration = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

    const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = base64UrlEncode(JSON.stringify({
        aud: audience,
        exp: expiration,
        sub: 'mailto:contact@maisondepriere.app',
    }));

    const unsignedToken = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        vapidKey,
        new TextEncoder().encode(unsignedToken)
    );

    // Convert DER signature to raw r||s
    const rawSig = derToRaw(new Uint8Array(signature));
    const jwt = `${unsignedToken}.${base64UrlEncode(rawSig)}`;

    // Encrypt payload using Web Push encryption (simplified — aes128gcm)
    const encrypted = await encryptPayload(sub, payload);

    // Send to push service
    const response = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'TTL': '86400',
            'Urgency': 'high',
        },
        body: encrypted,
    });

    return response;
}

async function encryptPayload(sub, payload) {
    const clientPublicKey = base64UrlDecode(sub.p256dh);
    const clientAuth = base64UrlDecode(sub.auth);

    // Generate ephemeral ECDH key pair
    const ephemeralKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
    );

    // Import client's public key
    const clientKey = await crypto.subtle.importKey(
        'raw',
        clientPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );

    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: clientKey },
        ephemeralKeyPair.privateKey,
        256
    );

    // Export ephemeral public key
    const ephemeralPublicKey = await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey);

    // Derive encryption key using HKDF
    const sharedSecretKey = await crypto.subtle.importKey(
        'raw',
        sharedSecret,
        { name: 'HKDF' },
        false,
        ['deriveBits']
    );

    // Info for auth_secret HKDF
    const authInfo = new TextEncoder().encode('WebPush: info\0');
    const authInfoFull = concatenate(authInfo, new Uint8Array(clientPublicKey), new Uint8Array(ephemeralPublicKey));

    // PRK using auth secret
    const prkKey = await crypto.subtle.importKey('raw', clientAuth, { name: 'HKDF' }, false, ['deriveBits']);
    const prk = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(sharedSecret), info: authInfoFull },
        prkKey,
        256
    );

    // Derive content encryption key
    const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
    const prkImported = await crypto.subtle.importKey('raw', new Uint8Array(prk), { name: 'HKDF' }, false, ['deriveBits']);
    const cek = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: cekInfo },
        prkImported,
        128
    );

    // Derive nonce
    const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
    const nonce = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: nonceInfo },
        prkImported,
        96
    );

    // Encrypt with AES-128-GCM
    const aesKey = await crypto.subtle.importKey('raw', new Uint8Array(cek), { name: 'AES-GCM' }, false, ['encrypt']);
    const paddedPayload = concatenate(new TextEncoder().encode(payload), new Uint8Array([2])); // 2 = delimiter

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(nonce) },
        aesKey,
        paddedPayload
    );

    // Build aes128gcm header
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const header = new Uint8Array(21 + ephemeralPublicKey.byteLength);
    header.set(salt, 0);
    const recordSize = new DataView(new ArrayBuffer(4));
    recordSize.setUint32(0, 4096);
    header.set(new Uint8Array(recordSize.buffer), 16);
    header[20] = ephemeralPublicKey.byteLength;
    header.set(new Uint8Array(ephemeralPublicKey), 21);

    return concatenate(header, new Uint8Array(encrypted));
}

// ═══════════════════════════════════════════════════
// UTILITY FUNCTIONS 
// ═══════════════════════════════════════════════════

function base64UrlDecode(str) {
    const padding = '='.repeat((4 - str.length % 4) % 4);
    const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    return Uint8Array.from([...binary].map(c => c.charCodeAt(0))).buffer;
}

function base64UrlEncode(input) {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    const base64 = btoa(String.fromCharCode(...data));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function concatenate(...arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(new Uint8Array(arr.buffer || arr), offset);
        offset += arr.byteLength;
    }
    return result;
}

function derToRaw(der) {
    // DER ECDSA signature to raw r||s (32 bytes each)
    const raw = new Uint8Array(64);
    let offset = 2; // skip SEQUENCE tag and length

    // Read r
    if (der[offset] !== 0x02) throw new Error('Invalid DER');
    offset++;
    const rLen = der[offset++];
    const rStart = rLen === 33 ? offset + 1 : offset; // skip leading 0 if present
    const rBytes = rLen === 33 ? 32 : rLen;
    raw.set(der.slice(rStart, rStart + Math.min(rBytes, 32)), 32 - Math.min(rBytes, 32));
    offset += rLen;

    // Read s
    if (der[offset] !== 0x02) throw new Error('Invalid DER');
    offset++;
    const sLen = der[offset++];
    const sStart = sLen === 33 ? offset + 1 : offset;
    const sBytes = sLen === 33 ? 32 : sLen;
    raw.set(der.slice(sStart, sStart + Math.min(sBytes, 32)), 32 + 32 - Math.min(sBytes, 32));

    return raw;
}

function parseDeviceName(ua) {
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Firefox')) return 'Firefox';
    return 'Unknown';
}

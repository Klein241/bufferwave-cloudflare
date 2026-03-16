# 🚀 Guide de déploiement — Notifications Push + Stockage

## Étape 1 : Exécuter le SQL push_subscriptions

Va dans **Supabase → SQL Editor** et exécute le fichier :
```
supabase-migrations/push_subscriptions.sql
```

## Étape 2 : Configurer les variables d'environnement

### 2a. Ajouter `NEXT_PUBLIC_WORKER_URL` dans `.env.local` :
```
NEXT_PUBLIC_WORKER_URL=https://maisondepriere-push.<ton-subdomain>.workers.dev
```

### 2b. (Optionnel) Google Drive Client ID pour backup :
```
NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID=<ton-google-client-id>
```
→ Créé dans Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs

## Étape 3 : Déployer le Worker Cloudflare

```bash
cd maisondepriere-push

# Stocker les secrets
wrangler secret put VAPID_PUBLIC_KEY
# Coller: BLr69ZgzX8t6VHWcjbAAGfQGKg51mauQgE0-saSRoATJlNmd_cePxuvQ6ef68dlwjbssDY0rvj4wFaj29YWKVEYw

wrangler secret put VAPID_PRIVATE_KEY
# Coller: cOEUk194xVQhRWYZPvEP4zsceeTp4QTv3uenfV05htI

wrangler secret put SUPABASE_URL
# Coller: https://xxx.supabase.co (ton URL Supabase)

wrangler secret put SUPABASE_SERVICE_KEY
# Coller: ta clé service_role Supabase

# Déployer
wrangler deploy
```

## Étape 4 : Configurer le Webhook Supabase

Va dans **Supabase → Database → Webhooks** et crée ces webhooks :

### Webhook 1 : Messages marketplace
- **Table** : `marketplace_messages`
- **Events** : `INSERT`
- **URL** : `https://maisondepriere-push.<subdomain>.workers.dev/api/push/webhook`
- **Headers** : `Authorization: Bearer <SUPABASE_SERVICE_KEY>`

### Webhook 2 : Commandes marketplace
- **Table** : `marketplace_orders`
- **Events** : `INSERT`
- **URL** : même URL
- **Headers** : même header

### Webhook 3 : Messages communauté
- **Table** : `messages`
- **Events** : `INSERT`
- **URL** : même URL
- **Headers** : même header

### Webhook 4 : Prières (optionnel)
- **Table** : `prayer_requests`
- **Events** : `INSERT`
- **URL** : même URL
- **Headers** : même header

## Étape 5 : Tester

1. Ouvre l'app dans Chrome
2. Accepte les notifications (le popup apparaît après 10s de login)
3. Vérifie dans Supabase → `push_subscriptions` qu'une ligne existe
4. Test le health check : `curl https://maisondepriere-push.<subdomain>.workers.dev/api/push/health`
5. Ferme Chrome, envoie un message depuis un autre compte → la notification push devrait arriver

## Architecture finale

```
┌─────────────────────────┐
│   Navigateur (PWA)      │
│   ├── sw.js (Push)      │
│   ├── IndexedDB (média) │
│   └── PushManager       │
└───────────┬─────────────┘
            │ subscribe
            ▼
┌─────────────────────────┐     ┌──────────────────┐
│  Cloudflare Worker      │◄────│ Supabase Webhook  │
│  maisondepriere-push    │     │ (INSERT trigger)  │
│  ├── /api/push/register │     └──────────────────┘
│  ├── /api/push/send     │
│  └── /api/push/webhook  │
└───────────┬─────────────┘
            │ Web Push (RFC 8291)
            ▼
┌─────────────────────────┐
│  Push Service (Google/  │
│  Mozilla/Apple)         │
│  → notification arrive  │
│    même navigateur fermé│
└─────────────────────────┘

Stockage média :
┌─────────────────────────┐
│  Upload: File → Supabase│ (URL temporaire)
│  Cache:  → IndexedDB    │ (permanent, offline)
│  Backup: → Google Drive │ (user's own account)
│  Cleanup: Supabase >30j │ (copies safe ailleurs)
└─────────────────────────┘
```

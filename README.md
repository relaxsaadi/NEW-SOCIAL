# Social Signal Translator (SST)

> "Decode what people really mean. Instantly."

## Vue d'ensemble

**Social Signal Translator** est une plateforme SaaS qui utilise l'IA pour analyser les messages textes et les situations sociales ambiguës, fournissant une interprétation structurée, objective et actionnable.

---

## Fonctionnalités implémentées ✅

- **Landing Page** — Hero, démo interactive, pricing, capture leads
- **Checkout Stripe** — Session de paiement créée côté serveur (mode invité)
- **Webhook Stripe** — Vérification signature, idempotency, mise à jour DB
- **Formulaire Intake** — Sélection de mode, contexte, texte libre
- **Moteur IA** — 4 couches de prompts (Maître, Sécurité, Mode, Offre)
- **Page Processing** — Polling, barre de progression, animations
- **Page Résultat** — Scores animés, lectures, signaux, actions recommandées
- **Upsell Reply Generator** — Second checkout Stripe post-analyse
- **Admin Dashboard** — Liste analyses, stats revenus, détail JSON
- **Sécurité** — Filtres de contenu, blocage automatique, ressources d'aide
- **GDPR** — Pages /privacy et /terms, minimisation données

---

## URLs

| Page | URL |
|------|-----|
| Landing | `/` |
| Comment ça marche | `/#how-it-works` |
| Pricing | `/#pricing` |
| Résultat demo | `/result/01TEST_ANALYSIS_COMPLETED` |
| Admin | `/admin/dashboard` |
| Privacy | `/privacy` |
| Terms | `/terms` |

### Endpoints API

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/create-checkout-session` | Créer une session Stripe |
| POST | `/api/webhooks/stripe` | Webhook Stripe |
| POST | `/api/analyze` | Soumettre l'analyse |
| GET | `/api/result/:id` | Récupérer le résultat |
| POST | `/api/generate-reply` | Générer des réponses (upsell) |
| GET | `/api/checkout-status` | Vérifier statut paiement |
| POST | `/api/create-upsell-session` | Checkout upsell |
| POST | `/api/leads` | Capture email |
| GET | `/api/admin/analyses` | Liste admin (JSON) |

---

## Offres

| Offre | Prix | Description |
|-------|------|-------------|
| Quick Decode | 19€ | Analyse rapide d'un message |
| Deep Read | 29€ | Analyse approfondie avec dynamiques |
| Pattern Analysis | 59€ | Analyse de relation sur la durée |
| Reply Generator | 9€ | Add-on : 3 suggestions de réponse |

---

## Architecture Technique

```
Stack:
  Frontend : Hono JSX + TailwindCSS CDN (SSR sur Workers)
  Backend  : Hono.js sur Cloudflare Workers
  Database : Cloudflare D1 (SQLite)
  Paiement : Stripe Checkout (mode hosted)
  IA       : OpenAI GPT-4o / compatible
  Hosting  : Cloudflare Pages
```

## Modèles de données

- `users` — Email uniquement, créé via Stripe
- `analyses` — Cœur du système, machine d'états
- `payments` — Paiements Stripe, idempotents
- `upsells` — Achats add-ons
- `events_logs` — Audit trail complet
- `leads` — Emails capturés avant paiement
- `prompts_versions` — Versioning des prompts IA

---

## Setup local

### 1. Variables d'environnement

```bash
# .dev.vars (ne jamais committer)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1
ADMIN_USER=admin
ADMIN_PASS=your_password
APP_URL=http://localhost:3000
```

### 2. Base de données

```bash
npm run db:migrate:local  # Applique le schema
npm run db:seed           # Données de test (optionnel)
```

### 3. Démarrer

```bash
npm run build
pm2 start ecosystem.config.cjs
# ou: npm run dev:sandbox
```

---

## Déploiement Cloudflare Pages

```bash
# 1. Créer la DB D1
npx wrangler d1 create sst-production

# 2. Mettre à jour l'ID dans wrangler.jsonc

# 3. Appliquer migrations
npm run db:migrate:prod

# 4. Déployer
npm run deploy

# 5. Ajouter les secrets
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name webapp
npx wrangler pages secret put LLM_API_KEY --project-name webapp
# ... etc
```

---

## Machine d'états (analyses.status)

```
pending_payment → paid → intake_pending → generating → completed
                   ↓                          ↓
                 failed                     blocked
```

---

## Admin

- URL: `/admin/dashboard`
- Auth: Basic Auth (ADMIN_USER / ADMIN_PASS dans .dev.vars)
- Fonctions: Voir analyses, stats revenus, détail JSON IA

---

## Fonctionnalités non implémentées (V2)

- [ ] Abonnement mensuel récurrent
- [ ] Espace client avec historique
- [ ] App mobile native
- [ ] API publique pour développeurs
- [ ] A/B testing prompts depuis l'admin
- [ ] Email transactionnel (Resend)
- [ ] Webhooks upsell Stripe automatiques

---

## Déploiement

- **Platform**: Cloudflare Pages
- **Status**: 🔧 Local Development (à déployer)
- **Tech Stack**: Hono + TypeScript + TailwindCSS + Cloudflare D1 + Stripe
- **Dernière mise à jour**: Avril 2026

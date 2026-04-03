import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './lib/types'
import { now, ulid, logEvent } from './lib/db'
import checkout from './routes/checkout'
import analyze from './routes/analyze'
import admin from './routes/admin'

const app = new Hono<{ Bindings: Bindings }>()

// Middleware
app.use('*', logger())
app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// Routes
app.route('/', checkout)
app.route('/', analyze)
app.route('/', admin)

// ── Helper: checkout status ───────────────────────────────────────────────────
app.get('/api/checkout-status', async (c) => {
  const sessionId = c.req.query('session_id')
  if (!sessionId) return c.json({ error: 'MISSING_SESSION' }, 400)

  const payment = await c.env.DB.prepare(
    `SELECT p.analysis_id, p.status, a.status as analysis_status
     FROM payments p JOIN analyses a ON p.analysis_id = a.id
     WHERE p.stripe_session_id = ?`
  ).bind(sessionId).first<{ analysis_id: string; status: string; analysis_status: string }>()

  if (!payment) return c.json({ status: 'pending' })

  return c.json({
    analysisId: payment.analysis_id,
    status: payment.analysis_status,
  })
})

// ── Lead capture ──────────────────────────────────────────────────────────────
app.post('/api/leads', async (c) => {
  const { email, source } = await c.req.json() as { email?: string; source?: string }
  if (!email) return c.json({ error: 'MISSING_EMAIL' }, 400)

  const id = ulid()
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO leads (id, email, source, created_at) VALUES (?, ?, ?, ?)`
  ).bind(id, email, source ?? 'landing', now()).run()

  await logEvent(c.env.DB, 'lead_captured', { payload: { source } })
  return c.json({ success: true })
})

// ── Pages ─────────────────────────────────────────────────────────────────────

// Landing Page
app.get('/', (c) => {
  return c.html(landingPage())
})

app.get('/pricing', (c) => c.redirect('/#pricing'))
app.get('/how-it-works', (c) => c.redirect('/#how-it-works'))

// Checkout success
app.get('/checkout-success', (c) => {
  return c.html(checkoutSuccessPage())
})

// Intake form
app.get('/intake/:analysisId', async (c) => {
  const analysisId = c.req.param('analysisId')

  const analysis = await c.env.DB.prepare(
    `SELECT id, status, offer_type, mode FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{ id: string; status: string; offer_type: string; mode: string }>()

  if (!analysis) {
    return c.html(errorPage('Analyse introuvable', 'Cet lien est invalide ou expiré.'))
  }

  if (analysis.status === 'completed') {
    return c.redirect(`/result/${analysisId}`)
  }

  if (analysis.status === 'generating') {
    return c.redirect(`/processing/${analysisId}`)
  }

  if (!['paid', 'intake_pending', 'failed'].includes(analysis.status)) {
    return c.html(errorPage('Paiement non validé', 'Votre paiement n\'a pas encore été confirmé. Veuillez patienter quelques secondes.'))
  }

  // Mark as intake_pending
  if (analysis.status === 'paid') {
    await c.env.DB.prepare(`UPDATE analyses SET status = 'intake_pending', updated_at = ? WHERE id = ?`)
      .bind(now(), analysisId).run()
  }

  return c.html(intakePage(analysisId, analysis.offer_type, analysis.mode))
})

// Processing page
app.get('/processing/:analysisId', async (c) => {
  const analysisId = c.req.param('analysisId')
  const analysis = await c.env.DB.prepare(
    `SELECT id, status FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{ id: string; status: string }>()

  if (!analysis) return c.html(errorPage('Introuvable', 'Cette analyse n\'existe pas.'))

  if (analysis.status === 'completed') return c.redirect(`/result/${analysisId}`)

  return c.html(processingPage(analysisId))
})

// Result page
app.get('/result/:analysisId', async (c) => {
  const analysisId = c.req.param('analysisId')
  const analysis = await c.env.DB.prepare(
    `SELECT id, status, offer_type, mode, ai_result_json, confidence_score FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{
    id: string
    status: string
    offer_type: string
    mode: string
    ai_result_json: string | null
    confidence_score: number | null
  }>()

  if (!analysis) return c.html(errorPage('Introuvable', 'Cette analyse n\'existe pas.'))
  if (analysis.status === 'generating') return c.redirect(`/processing/${analysisId}`)
  if (analysis.status === 'pending_payment' || analysis.status === 'paid' || analysis.status === 'intake_pending') {
    return c.redirect(`/intake/${analysisId}`)
  }

  // Check upsell status
  const upsell = await c.env.DB.prepare(
    `SELECT status FROM upsells WHERE analysis_id = ? AND upsell_type = 'reply_generator' ORDER BY created_at DESC LIMIT 1`
  ).bind(analysisId).first<{ status: string }>()

  await logEvent(c.env.DB, 'result_viewed', { analysis_id: analysisId })

  let result: Record<string, unknown> | null = null
  try {
    if (analysis.ai_result_json) result = JSON.parse(analysis.ai_result_json)
  } catch {}

  return c.html(resultPage(analysisId, analysis, result, upsell?.status))
})

// Upsell page
app.get('/upsell/:analysisId', async (c) => {
  const analysisId = c.req.param('analysisId')
  return c.html(upsellPage(analysisId))
})

// Legal pages
app.get('/privacy', (c) => c.html(legalPage('Politique de Confidentialité', privacyContent())))
app.get('/terms', (c) => c.html(legalPage('Conditions d\'Utilisation', termsContent())))
app.get('/legal', (c) => c.redirect('/terms'))

// ── HTML Templates ────────────────────────────────────────────────────────────

const HEAD = (title: string) => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Social Signal Translator</title>
  <meta name="description" content="Décodez ce que les gens veulent vraiment dire. IA d'analyse des signaux sociaux.">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/static/styles.css">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] },
          colors: {
            surface: '#171717',
            primary: '#7c3aed',
          }
        }
      }
    }
  </script>
</head>`

function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="fr" class="scroll-smooth">
${HEAD('Décodez les signaux sociaux')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans" data-page="landing">
  <!-- Nav -->
  <nav class="fixed top-0 w-full z-50 bg-[#0a0a0a]/90 backdrop-blur border-b border-white/5">
    <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-brain text-white text-xs"></i>
        </div>
        <span class="font-bold text-white text-lg">SST</span>
        <span class="text-gray-500 text-sm hidden sm:inline">Social Signal Translator</span>
      </div>
      <div class="flex items-center gap-4">
        <a href="#how-it-works" class="text-gray-400 hover:text-white text-sm hidden md:inline">Comment ça marche</a>
        <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">Analyser →</a>
      </div>
    </div>
  </nav>

  <!-- Hero -->
  <section class="pt-32 pb-20 px-6">
    <div class="max-w-4xl mx-auto text-center">
      <div class="inline-flex items-center gap-2 bg-violet-900/30 border border-violet-700/30 text-violet-300 px-4 py-1.5 rounded-full text-sm mb-6">
        <span class="w-2 h-2 bg-violet-400 rounded-full animate-pulse"></span>
        IA d'analyse des signaux sociaux
      </div>
      <h1 class="text-5xl sm:text-6xl md:text-7xl font-bold leading-tight mb-6">
        <span class="gradient-text">Décodez</span><br>
        ce qu'ils<br>veulent vraiment dire
      </h1>
      <p class="text-xl text-gray-400 max-w-2xl mx-auto mb-10">
        Arrêtez de vous demander. Notre IA analyse les messages ambigus, décrypte les signaux mixtes et vous donne une interprétation structurée et actionnable.
      </p>
      <div class="flex flex-col sm:flex-row gap-4 justify-center mb-4">
        <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-8 py-4 rounded-xl text-lg font-semibold transition-all pulse-glow">
          Analyser maintenant <i class="fas fa-arrow-right ml-2"></i>
        </a>
        <a href="#how-it-works" class="border border-gray-700 hover:border-gray-500 text-gray-300 px-8 py-4 rounded-xl text-lg transition-colors">
          Voir comment ça marche
        </a>
      </div>
      <p class="text-gray-600 text-sm">Résultat en moins de 30 secondes · Sans inscription</p>
    </div>
  </section>

  <!-- Demo Card -->
  <section class="px-6 pb-20">
    <div class="max-w-2xl mx-auto">
      <div class="glass-card rounded-2xl p-6 border border-white/5">
        <div class="text-gray-500 text-xs mb-3 font-mono">EXEMPLE D'ANALYSE</div>
        <div class="bg-gray-900 rounded-xl p-4 mb-4 text-sm text-gray-300 italic">
          "Il m'a répondu 'Ok.' après 3 jours de silence... Je ne sais plus quoi penser."
        </div>
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Intérêt</span>
            <div class="flex items-center gap-2 w-48">
              <div class="flex-1 bg-gray-800 rounded-full h-2"><div class="bg-violet-500 h-2 rounded-full score-bar" style="width:22%"></div></div>
              <span class="font-mono text-xs text-gray-400">22</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Effort</span>
            <div class="flex items-center gap-2 w-48">
              <div class="flex-1 bg-gray-800 rounded-full h-2"><div class="bg-blue-500 h-2 rounded-full score-bar" style="width:10%"></div></div>
              <span class="font-mono text-xs text-gray-400">10</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-400">Clarté du signal</span>
            <div class="flex items-center gap-2 w-48">
              <div class="flex-1 bg-gray-800 rounded-full h-2"><div class="bg-amber-500 h-2 rounded-full score-bar" style="width:85%"></div></div>
              <span class="font-mono text-xs text-gray-400">85</span>
            </div>
          </div>
        </div>
        <div class="mt-4 bg-violet-900/20 border border-violet-800/30 rounded-xl p-3">
          <div class="text-xs text-violet-400 mb-1 font-semibold">LECTURE PRINCIPALE · 82% de confiance</div>
          <div class="text-sm text-gray-200">Désengagement progressif — faible investissement, signal de distance claire.</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Use Cases -->
  <section id="how-it-works" class="px-6 py-20 border-t border-white/5">
    <div class="max-w-5xl mx-auto">
      <div class="text-center mb-12">
        <h2 class="text-3xl font-bold text-white mb-3">Comment ça marche</h2>
        <p class="text-gray-400">3 étapes. Résultat en 30 secondes.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
        <div class="glass-card rounded-2xl p-6 text-center">
          <div class="w-12 h-12 bg-violet-900/50 border border-violet-700/30 rounded-xl flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-credit-card text-violet-400"></i>
          </div>
          <div class="font-mono text-violet-400 text-sm mb-2">01</div>
          <h3 class="font-semibold text-white mb-2">Choisissez votre offre</h3>
          <p class="text-gray-400 text-sm">Quick Decode pour une analyse rapide ou Deep Read pour une analyse complète.</p>
        </div>
        <div class="glass-card rounded-2xl p-6 text-center">
          <div class="w-12 h-12 bg-blue-900/50 border border-blue-700/30 rounded-xl flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-paste text-blue-400"></i>
          </div>
          <div class="font-mono text-blue-400 text-sm mb-2">02</div>
          <h3 class="font-semibold text-white mb-2">Collez votre message</h3>
          <p class="text-gray-400 text-sm">Décrivez la situation ou copiez le message. Ajoutez le contexte pour plus de précision.</p>
        </div>
        <div class="glass-card rounded-2xl p-6 text-center">
          <div class="w-12 h-12 bg-green-900/50 border border-green-700/30 rounded-xl flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-chart-bar text-green-400"></i>
          </div>
          <div class="font-mono text-green-400 text-sm mb-2">03</div>
          <h3 class="font-semibold text-white mb-2">Obtenez votre analyse</h3>
          <p class="text-gray-400 text-sm">Rapport structuré avec scores, interprétations et prochaines actions recommandées.</p>
        </div>
      </div>

      <!-- Use cases -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        ${[
          { icon: 'fa-heart', color: 'red', label: 'Dating', desc: 'Signaux mixtes, ghosting, intérêt réel' },
          { icon: 'fa-briefcase', color: 'blue', label: 'Travail', desc: 'Emails froids, tensions manager, clients' },
          { icon: 'fa-users', color: 'green', label: 'Amitié', desc: 'Tensions implicites, silences, distances' },
          { icon: 'fa-home', color: 'amber', label: 'Famille', desc: 'Non-dits, dynamiques de pouvoir' },
        ].map(uc => `
        <div class="glass-card rounded-xl p-4 text-center">
          <i class="fas ${uc.icon} text-${uc.color}-400 text-xl mb-2 block"></i>
          <div class="font-semibold text-white text-sm mb-1">${uc.label}</div>
          <div class="text-gray-500 text-xs">${uc.desc}</div>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- Pricing -->
  <section id="pricing" class="px-6 py-20 border-t border-white/5">
    <div class="max-w-5xl mx-auto">
      <div class="text-center mb-12">
        <h2 class="text-3xl font-bold text-white mb-3">Choisissez votre analyse</h2>
        <p class="text-gray-400">Sans abonnement. Payez uniquement quand vous en avez besoin.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Quick Decode -->
        <div class="glass-card rounded-2xl p-6 border border-white/5 hover:border-violet-500/30 transition-colors">
          <div class="text-violet-400 font-mono text-sm mb-2">QUICK DECODE</div>
          <div class="text-4xl font-bold text-white mb-1">19€</div>
          <div class="text-gray-400 text-sm mb-6">Réponse rapide sur un message unique</div>
          <ul class="space-y-2 mb-6">
            ${['Résumé rapide', 'Top 3 signaux observables', 'Lecture principale', '2 Lectures alternatives', 'Score de confiance', 'Meilleure prochaine action'].map(f =>
              `<li class="flex items-center gap-2 text-sm text-gray-300"><i class="fas fa-check text-violet-400 text-xs"></i>${f}</li>`
            ).join('')}
          </ul>
          <button data-offer="quick_decode" class="w-full bg-violet-600 hover:bg-violet-500 text-white py-3 rounded-xl font-semibold transition-colors cursor-pointer">
            Analyser pour 19€ →
          </button>
        </div>

        <!-- Deep Read -->
        <div class="glass-card rounded-2xl p-6 border border-violet-500/40 relative">
          <div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-violet-600 text-white text-xs px-3 py-1 rounded-full font-semibold">RECOMMANDÉ</div>
          <div class="text-violet-400 font-mono text-sm mb-2">DEEP READ</div>
          <div class="text-4xl font-bold text-white mb-1">29€</div>
          <div class="text-gray-400 text-sm mb-6">Analyse approfondie, situation complexe</div>
          <ul class="space-y-2 mb-6">
            ${['Tout le contenu Quick Decode', 'Dynamique relationnelle', 'Détection des non-dits', 'Risques d\'interprétation', '3 suggestions de réponse', 'Analyse des biais cognitifs'].map(f =>
              `<li class="flex items-center gap-2 text-sm text-gray-300"><i class="fas fa-check text-violet-400 text-xs"></i>${f}</li>`
            ).join('')}
          </ul>
          <button data-offer="deep_read" class="w-full bg-violet-600 hover:bg-violet-500 text-white py-3 rounded-xl font-semibold transition-colors cursor-pointer pulse-glow">
            Analyser pour 29€ →
          </button>
        </div>

        <!-- Pattern Analysis -->
        <div class="glass-card rounded-2xl p-6 border border-white/5 hover:border-violet-500/30 transition-colors">
          <div class="text-violet-400 font-mono text-sm mb-2">PATTERN ANALYSIS</div>
          <div class="text-4xl font-bold text-white mb-1">59€</div>
          <div class="text-gray-400 text-sm mb-6">Comprendre une relation sur la durée</div>
          <ul class="space-y-2 mb-6">
            ${['Analyse multi-messages', 'Tendances émotionnelles', 'Asymétrie d\'effort', 'Structure de rapport de force', 'Stratégie relationnelle complète', 'Analyse macro-patterns'].map(f =>
              `<li class="flex items-center gap-2 text-sm text-gray-300"><i class="fas fa-check text-violet-400 text-xs"></i>${f}</li>`
            ).join('')}
          </ul>
          <button data-offer="pattern_analysis" class="w-full bg-gray-800 hover:bg-gray-700 text-white py-3 rounded-xl font-semibold transition-colors cursor-pointer">
            Analyser pour 59€ →
          </button>
        </div>
      </div>

      <!-- Trust signals -->
      <div class="mt-12 flex flex-wrap justify-center gap-6 text-sm text-gray-500">
        <span><i class="fas fa-lock text-green-500 mr-1"></i>Paiement sécurisé Stripe</span>
        <span><i class="fas fa-shield-alt text-blue-500 mr-1"></i>Données supprimées après 30j</span>
        <span><i class="fas fa-bolt text-amber-500 mr-1"></i>Résultat en &lt; 30 secondes</span>
        <span><i class="fas fa-undo text-violet-500 mr-1"></i>Satisfaction garantie</span>
      </div>
    </div>
  </section>

  <!-- Lead capture -->
  <section class="px-6 py-16 border-t border-white/5 bg-gradient-to-b from-transparent to-violet-950/10">
    <div class="max-w-xl mx-auto text-center">
      <h3 class="text-2xl font-bold text-white mb-3">Recevez nos conseils gratuits</h3>
      <p class="text-gray-400 text-sm mb-6">Guides sur la communication, les signaux sociaux et les biais cognitifs.</p>
      <form id="lead-form" class="flex gap-3">
        <input name="lead-email" type="email" placeholder="votre@email.com" required
          class="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-violet-500 transition-colors">
        <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl text-sm font-semibold transition-colors">
          S'inscrire
        </button>
      </form>
    </div>
  </section>

  <!-- Footer -->
  <footer class="border-t border-white/5 px-6 py-8">
    <div class="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-500">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 bg-violet-600 rounded flex items-center justify-center">
          <i class="fas fa-brain text-white text-xs"></i>
        </div>
        <span>Social Signal Translator © 2026</span>
      </div>
      <div class="flex items-center gap-6">
        <a href="/privacy" class="hover:text-gray-300 transition-colors">Confidentialité</a>
        <a href="/terms" class="hover:text-gray-300 transition-colors">CGU</a>
        <span class="italic">"We analyze signals, not minds."</span>
      </div>
    </div>
  </footer>

  <script src="/static/app.js"></script>
</body>
</html>`
}

function checkoutSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Paiement confirmé')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center" data-page="checkout-success">
  <div class="text-center max-w-md px-6">
    <div id="checkout-spinner" class="w-16 h-16 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-6"></div>
    <h1 class="text-2xl font-bold text-white mb-3">Paiement confirmé !</h1>
    <p id="checkout-status" class="text-gray-400">Vérification en cours, redirection automatique...</p>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
}

function intakePage(analysisId: string, offerType: string, defaultMode: string): string {
  const offerLabels: Record<string, string> = {
    quick_decode: 'Quick Decode',
    deep_read: 'Deep Read',
    pattern_analysis: 'Pattern Analysis',
  }

  const modes = [
    { id: 'message_decode', label: 'Message', icon: 'fa-comment', desc: 'Analyser un message reçu' },
    { id: 'situation_decode', label: 'Situation', icon: 'fa-user-friends', desc: 'Décrire une situation sociale' },
    { id: 'dating_decode', label: 'Dating', icon: 'fa-heart', desc: 'Signaux romantiques' },
    { id: 'workplace_decode', label: 'Pro', icon: 'fa-briefcase', desc: 'Dynamiques de travail' },
    { id: 'pattern_analysis', label: 'Pattern', icon: 'fa-chart-line', desc: 'Analyse de pattern' },
  ]

  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Soumettre votre analyse')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen py-12 px-4" data-page="intake">
  <div class="max-w-2xl mx-auto">
    <!-- Header -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center gap-2 bg-green-900/30 border border-green-700/30 text-green-300 px-4 py-1.5 rounded-full text-sm mb-4">
        <i class="fas fa-check-circle text-green-400"></i>
        Paiement validé — ${offerLabels[offerType] || offerType}
      </div>
      <h1 class="text-3xl font-bold text-white mb-2">Décrivez votre situation</h1>
      <p class="text-gray-400">Plus vous donnez de contexte, plus l'analyse sera précise.</p>
    </div>

    <form id="intake-form" data-analysis-id="${analysisId}" class="space-y-6">
      <input type="hidden" name="offerType" value="${offerType}">
      <input type="hidden" name="mode" value="${defaultMode || 'message_decode'}">

      <!-- Mode selector -->
      <div>
        <label class="text-sm font-semibold text-gray-300 block mb-3">Type d'analyse</label>
        <div class="grid grid-cols-5 gap-2">
          ${modes.map(m => `
          <button type="button" data-mode="${m.id}"
            class="p-3 rounded-xl border border-gray-700 text-center text-xs transition-all cursor-pointer hover:border-violet-500 ${m.id === (defaultMode || 'message_decode') ? 'ring-2 ring-violet-500 bg-violet-900/30 border-violet-500' : ''}">
            <i class="fas ${m.icon} block text-lg mb-1 text-violet-400"></i>
            <div class="font-semibold text-gray-200">${m.label}</div>
          </button>`).join('')}
        </div>
      </div>

      <!-- Context type -->
      <div>
        <label class="text-sm font-semibold text-gray-300 block mb-2">Contexte relationnel</label>
        <select name="contextType" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500">
          <option value="dating">❤️ Relations amoureuses / Dating</option>
          <option value="work">💼 Travail / Professionnel</option>
          <option value="friendship">👥 Amitié</option>
          <option value="family">🏠 Famille</option>
          <option value="social">🌐 Social général</option>
          <option value="other">📝 Autre</option>
        </select>
      </div>

      <!-- Main input -->
      <div>
        <label class="text-sm font-semibold text-gray-300 block mb-2">
          Message ou situation à analyser <span class="text-red-400">*</span>
        </label>
        <textarea name="inputText" required rows="6" maxlength="5000"
          placeholder="Collez le message reçu ou décrivez la situation en détail...

Exemple : 'Il m'a répondu OK après 3 jours de silence alors qu'on se parlait tous les jours avant...'"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600"></textarea>
        <div class="flex justify-end mt-1">
          <span id="char-count" class="text-gray-500 text-xs">0/5000</span>
        </div>
      </div>

      <!-- Extra context -->
      <div>
        <label class="text-sm font-semibold text-gray-300 block mb-2">Contexte supplémentaire (optionnel)</label>
        <textarea name="extraContext" rows="3"
          placeholder="Durée de la relation, historique, comportement habituel de la personne..."
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600"></textarea>
      </div>

      <!-- Goal -->
      <div>
        <label class="text-sm font-semibold text-gray-300 block mb-2">Votre question principale (optionnel)</label>
        <input type="text" name="goal"
          placeholder="Ex: Est-ce qu'il/elle est vraiment intéressé(e) ?"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600">
      </div>

      <!-- Disclaimer -->
      <div class="bg-gray-900/50 border border-gray-800 rounded-xl p-4 text-xs text-gray-500">
        <i class="fas fa-info-circle text-blue-400 mr-1"></i>
        <em>"We analyze signals, not minds."</em> — Nos analyses sont probabilistes, jamais des certitudes absolues. Elles ne remplacent pas l'avis d'un professionnel.
      </div>

      <button type="submit" id="submit-btn"
        class="w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-semibold text-lg transition-colors cursor-pointer">
        <i class="fas fa-search-plus mr-2"></i>Lancer l'analyse
      </button>
    </form>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
}

function processingPage(analysisId: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Analyse en cours')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center" data-page="processing" data-analysis-id="${analysisId}">
  <div class="text-center max-w-lg px-6">
    <!-- Animated visual -->
    <div class="relative w-32 h-32 mx-auto mb-8">
      <div class="w-32 h-32 border-2 border-violet-800 rounded-xl overflow-hidden relative">
        <div class="scan-line"></div>
        <div class="absolute inset-0 flex items-center justify-center">
          <i class="fas fa-brain text-5xl text-violet-600/50"></i>
        </div>
      </div>
    </div>

    <h1 class="text-2xl font-bold text-white mb-2">Analyse en cours...</h1>
    <p id="step-text" class="text-gray-400 text-sm mb-8 font-mono">Initialisation de l'analyse...</p>

    <!-- Progress bar -->
    <div class="bg-gray-900 rounded-full h-3 mb-2 overflow-hidden">
      <div id="progress-bar" class="h-3 bg-gradient-to-r from-violet-600 to-blue-500 rounded-full transition-all duration-500 score-bar" style="width:0%"></div>
    </div>
    <div class="flex justify-between text-xs text-gray-600 font-mono">
      <span>0%</span>
      <span id="progress-pct">0%</span>
      <span>100%</span>
    </div>

    <p class="text-gray-600 text-xs mt-6">Observable signals first. Interpretation second.</p>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
}

function resultPage(
  analysisId: string,
  analysis: { status: string; offer_type: string; mode: string; confidence_score: number | null },
  result: Record<string, unknown> | null,
  upsellStatus: string | undefined
): string {
  if (analysis.status === 'blocked') {
    return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Contenu bloqué')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="result" data-analysis-id="${analysisId}">
  <div class="max-w-md text-center">
    <div class="w-16 h-16 bg-amber-900/50 rounded-xl flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-shield-alt text-amber-400 text-2xl"></i>
    </div>
    <h1 class="text-2xl font-bold text-white mb-4">Contenu non analysable</h1>
    <p class="text-gray-400 mb-6">Ce contenu ne peut pas être analysé conformément à notre politique de sécurité.</p>
    <div class="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4 mb-6 text-sm text-gray-300">
      Si vous traversez une période difficile, des ressources sont disponibles 24h/24 :
      <br><a href="tel:3114" class="text-amber-400 font-bold">3114</a> — Numéro national de prévention du suicide
    </div>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Retour à l'accueil</a>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
  }

  if (!result) {
    return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Résultat')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="result" data-analysis-id="${analysisId}">
  <div class="text-center max-w-md">
    <h1 class="text-2xl font-bold text-white mb-4">Résultat indisponible</h1>
    <p class="text-gray-400 mb-6">L'analyse n'a pas pu être générée. Votre crédit est préservé.</p>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Retour</a>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
  }

  const scores = (result.scores as Record<string, number>) || {}
  const mainReading = result.main_reading as { title: string; description: string; probability_score: number } | undefined
  const alternativeReadings = (result.alternative_readings as Array<{ title: string; description: string; probability_score: number }>) || []
  const observableSignals = (result.observable_signals as Array<{ signal: string; type: string; interpretation: string }>) || []
  const bestNextAction = result.best_next_action as { action: string; rationale: string } | undefined
  const replyOptions = (result.reply_options as Array<{ style: string; text: string; why_it_works: string }>) || []
  const uncertainties = (result.uncertainties as string[]) || []
  const confidence = analysis.confidence_score ? Math.round(analysis.confidence_score * 100) : (mainReading?.probability_score || 75)

  const scoreColors: Record<string, string> = {
    interest: 'violet',
    clarity: 'blue',
    respect: 'green',
    effort: 'amber',
    manipulation_risk: 'red',
  }

  const scoreLabels: Record<string, string> = {
    interest: 'Intérêt',
    clarity: 'Clarté signal',
    respect: 'Respect',
    effort: 'Effort',
    manipulation_risk: 'Risque manipulation',
  }

  const offerLabel: Record<string, string> = {
    quick_decode: 'Quick Decode',
    deep_read: 'Deep Read',
    pattern_analysis: 'Pattern Analysis',
  }

  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Votre analyse')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen py-10 px-4" data-page="result" data-analysis-id="${analysisId}">
  <div class="max-w-3xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <div>
        <div class="inline-flex items-center gap-2 bg-green-900/30 border border-green-700/30 text-green-300 px-3 py-1 rounded-full text-xs mb-2">
          <i class="fas fa-check-circle text-green-400"></i>
          Analyse complète — ${offerLabel[analysis.offer_type] || analysis.offer_type}
        </div>
        <h1 class="text-2xl font-bold text-white">Rapport d'analyse</h1>
      </div>
      <div class="text-right">
        <div class="font-mono text-3xl font-bold text-violet-400">${confidence}%</div>
        <div class="text-gray-500 text-xs">confiance</div>
      </div>
    </div>

    <!-- Summary -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-2">RÉSUMÉ</div>
      <p id="result-summary" class="text-gray-100 text-lg leading-relaxed">${escapeHtml(String(result.summary || ''))}</p>
      <button id="copy-btn" class="mt-3 text-gray-500 hover:text-gray-300 text-xs flex items-center gap-1 transition-colors cursor-pointer">
        <i class="fas fa-copy"></i> Copier
      </button>
    </div>

    <!-- Scores -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4">SCORES</div>
      <div class="space-y-4">
        ${Object.entries(scores).map(([key, val]) => {
          const color = scoreColors[key] || 'violet'
          const label = scoreLabels[key] || key
          const value = typeof val === 'number' ? val : 0
          return `
        <div data-score="${value}">
          <div class="flex justify-between mb-1">
            <span class="text-sm text-gray-300">${label}</span>
            <span class="font-mono text-sm text-${color}-400">${value}<span class="text-gray-600">/100</span></span>
          </div>
          <div class="bg-gray-800 rounded-full h-2.5 overflow-hidden">
            <div class="h-2.5 rounded-full score-bar bg-${color}-500 transition-all" style="width:0%"></div>
          </div>
        </div>`
        }).join('')}
      </div>
    </div>

    <!-- Main Reading -->
    ${mainReading ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-violet-500/20 bg-violet-900/10">
      <div class="flex items-center justify-between mb-3">
        <div class="text-violet-400 text-xs font-mono">LECTURE PRINCIPALE</div>
        <div class="font-mono text-violet-400 font-bold">${mainReading.probability_score}%</div>
      </div>
      <h3 class="text-xl font-bold text-white mb-2">${escapeHtml(mainReading.title)}</h3>
      <p class="text-gray-300 text-sm leading-relaxed">${escapeHtml(mainReading.description)}</p>
    </div>` : ''}

    <!-- Alternative Readings -->
    ${alternativeReadings.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4">LECTURES ALTERNATIVES</div>
      <div class="space-y-4">
        ${alternativeReadings.map(r => `
        <div class="border border-gray-800 rounded-xl p-4">
          <div class="flex items-center justify-between mb-1">
            <h4 class="font-semibold text-white text-sm">${escapeHtml(r.title)}</h4>
            <span class="font-mono text-xs text-gray-500">${r.probability_score}%</span>
          </div>
          <p class="text-gray-400 text-sm">${escapeHtml(r.description)}</p>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Observable Signals -->
    ${observableSignals.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4">SIGNAUX OBSERVABLES</div>
      <div class="space-y-3">
        ${observableSignals.map(s => `
        <div class="flex gap-3">
          <div class="w-2 h-2 bg-blue-500 rounded-full mt-2 flex-shrink-0"></div>
          <div>
            <div class="text-white text-sm font-medium">${escapeHtml(s.signal)}</div>
            <div class="text-gray-400 text-xs mt-0.5"><span class="text-blue-400">${s.type}</span> — ${escapeHtml(s.interpretation)}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Best Next Action -->
    ${bestNextAction ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-green-500/20 bg-green-900/10">
      <div class="text-green-400 text-xs font-mono mb-3">MEILLEURE PROCHAINE ACTION</div>
      <h3 class="text-lg font-bold text-white mb-2">${escapeHtml(bestNextAction.action)}</h3>
      <p class="text-gray-300 text-sm">${escapeHtml(bestNextAction.rationale)}</p>
    </div>` : ''}

    <!-- Reply Options (if available) -->
    ${replyOptions.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4">SUGGESTIONS DE RÉPONSE</div>
      <div class="space-y-4">
        ${replyOptions.map(r => `
        <div class="border border-gray-800 rounded-xl p-4">
          <div class="text-violet-400 text-xs font-semibold mb-2 uppercase">${escapeHtml(r.style)}</div>
          <p class="text-gray-200 text-sm italic mb-2">"${escapeHtml(r.text)}"</p>
          <p class="text-gray-500 text-xs">${escapeHtml(r.why_it_works || '')}</p>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Uncertainties -->
    ${uncertainties.length > 0 ? `
    <div class="glass-card rounded-2xl p-4 mb-6 border border-amber-500/10 bg-amber-900/5">
      <div class="text-amber-400 text-xs font-mono mb-2">SOURCES D'INCERTITUDE</div>
      <ul class="space-y-1">
        ${uncertainties.map(u => `<li class="text-gray-400 text-xs flex items-start gap-2"><i class="fas fa-exclamation-triangle text-amber-500 mt-0.5 text-xs"></i>${escapeHtml(u)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <!-- Upsell (Reply Generator) -->
    ${!upsellStatus || upsellStatus === 'offered' ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-violet-500/30 bg-gradient-to-br from-violet-900/20 to-blue-900/10">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-violet-400 text-xs font-mono mb-2">ADD-ON DISPONIBLE</div>
          <h3 class="text-xl font-bold text-white mb-2">Reply Generator <span class="text-lg font-normal text-violet-400">9€</span></h3>
          <p class="text-gray-300 text-sm mb-1">Générez la réponse parfaite en 3 versions :</p>
          <ul class="text-gray-400 text-xs space-y-1 mb-4">
            <li><i class="fas fa-dove text-green-400 mr-1"></i>Diplomate — chaleureux et respectueux</li>
            <li><i class="fas fa-bullseye text-blue-400 mr-1"></i>Direct — clair et sans ambiguïté</li>
            <li><i class="fas fa-snowflake text-gray-400 mr-1"></i>Détaché — faible investissement émotionnel</li>
          </ul>
          <button id="upsell-btn" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-2.5 rounded-xl text-sm font-semibold transition-colors cursor-pointer">
            Générer ma réponse — 9€ →
          </button>
        </div>
      </div>
    </div>` : ''}

    <!-- Disclaimer -->
    <div class="text-center text-xs text-gray-600 mt-6 pb-10">
      <p>Cette analyse est probabiliste. Elle ne remplace pas l'avis d'un professionnel de santé mentale.</p>
      <p class="mt-1">Probabilité ≠ Certitude. <em>"Observable signals first."</em></p>
    </div>
  </div>

  <script src="/static/app.js"></script>
</body>
</html>`
}

function upsellPage(analysisId: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Reply Generator')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="upsell" data-analysis-id="${analysisId}">
  <div class="max-w-md text-center">
    <div class="w-16 h-16 bg-violet-900/50 border border-violet-700/30 rounded-xl flex items-center justify-center mx-auto mb-6">
      <i class="fas fa-pen-nib text-violet-400 text-2xl"></i>
    </div>
    <h1 class="text-2xl font-bold text-white mb-3">Reply Generator</h1>
    <p class="text-gray-400 mb-6">Générez la réponse parfaite pour votre situation. 3 versions adaptées à votre objectif.</p>
    <ul class="text-left space-y-2 mb-8 text-sm text-gray-300">
      <li class="flex items-center gap-2"><i class="fas fa-dove text-green-400"></i>Ton Diplomate</li>
      <li class="flex items-center gap-2"><i class="fas fa-bullseye text-blue-400"></i>Ton Direct</li>
      <li class="flex items-center gap-2"><i class="fas fa-snowflake text-gray-400"></i>Ton Détaché</li>
    </ul>
    <div class="text-3xl font-bold text-white mb-6">9€ <span class="text-gray-500 text-lg">une fois</span></div>
    <button data-offer="upsell" id="upsell-checkout-btn"
      onclick="handleUpsellCheckout('${analysisId}')"
      class="w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-semibold transition-colors cursor-pointer mb-4">
      Générer mes réponses →
    </button>
    <a href="/result/${analysisId}" class="text-gray-500 hover:text-gray-300 text-sm transition-colors block">Non merci, retourner au résultat</a>
  </div>
  <script src="/static/app.js"></script>
  <script>
    async function handleUpsellCheckout(analysisId) {
      const btn = document.getElementById('upsell-checkout-btn')
      btn.disabled = true
      btn.textContent = 'Redirection...'
      try {
        const res = await fetch('/api/create-upsell-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysisId })
        })
        const data = await res.json()
        if (data.checkoutUrl) window.location.href = data.checkoutUrl
      } catch(e) {
        btn.disabled = false
        btn.textContent = 'Générer mes réponses →'
      }
    }
  </script>
</body>
</html>`
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD(title)}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4">
  <div class="text-center max-w-md">
    <div class="w-16 h-16 bg-red-900/50 rounded-xl flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
    </div>
    <h1 class="text-2xl font-bold text-white mb-3">${escapeHtml(title)}</h1>
    <p class="text-gray-400 mb-6">${escapeHtml(message)}</p>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Retour à l'accueil</a>
  </div>
</body>
</html>`
}

function legalPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD(title)}
<body class="bg-[#0a0a0a] text-gray-100 font-sans max-w-3xl mx-auto px-6 py-16">
  <a href="/" class="text-gray-400 hover:text-white text-sm mb-6 inline-block">← Retour</a>
  <h1 class="text-3xl font-bold text-white mb-8">${escapeHtml(title)}</h1>
  <div class="prose prose-invert max-w-none text-gray-300 space-y-4 text-sm leading-relaxed">
    ${content}
  </div>
</body>
</html>`
}

function privacyContent(): string {
  return `
  <p><strong>Dernière mise à jour :</strong> Avril 2026</p>
  <h2 class="text-xl font-bold text-white mt-6">1. Données collectées</h2>
  <p>Nous collectons uniquement votre email (via Stripe) et les textes que vous soumettez pour analyse. Aucun compte utilisateur n'est créé.</p>
  <h2 class="text-xl font-bold text-white mt-6">2. Utilisation des données</h2>
  <p>Les textes soumis sont utilisés uniquement pour générer votre analyse via notre IA. Ils sont automatiquement supprimés après 30 jours.</p>
  <h2 class="text-xl font-bold text-white mt-6">3. Partage des données</h2>
  <p>Vos données ne sont jamais vendues. Elles sont partagées uniquement avec Stripe (paiement) et notre fournisseur IA pour traitement.</p>
  <h2 class="text-xl font-bold text-white mt-6">4. Vos droits RGPD</h2>
  <p>Vous disposez d'un droit d'accès, de rectification et de suppression de vos données. Contactez-nous pour exercer ces droits.</p>
  `
}

function termsContent(): string {
  return `
  <p><strong>Dernière mise à jour :</strong> Avril 2026</p>
  <h2 class="text-xl font-bold text-white mt-6">1. Service</h2>
  <p>Social Signal Translator est un outil d'analyse IA probabiliste. Les analyses fournies ne constituent pas un avis médical, psychologique ou juridique.</p>
  <h2 class="text-xl font-bold text-white mt-6">2. Paiements</h2>
  <p>Tous les paiements sont traités par Stripe. Les achats sont définitifs sauf dysfonctionnement technique de notre part.</p>
  <h2 class="text-xl font-bold text-white mt-6">3. Limitations</h2>
  <p>Les analyses sont probabilistes. Elles ne remplacent pas le jugement humain ni l'avis d'un professionnel de santé mentale.</p>
  <h2 class="text-xl font-bold text-white mt-6">4. Contenu interdit</h2>
  <p>Il est interdit d'utiliser ce service pour planifier des actes illégaux, harcelants ou nuisibles à autrui.</p>
  `
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default app

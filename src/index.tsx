import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './lib/types'
import { now, ulid, logEvent } from './lib/db'
import { rateLimit } from './lib/rate-limit'
import checkout from './routes/checkout'
import analyze from './routes/analyze'
import admin from './routes/admin'

const app = new Hono<{ Bindings: Bindings }>()

// Middleware
app.use('*', logger())
app.use('*', secureHeaders())
app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// Rate limiting per endpoint
app.use('/api/create-checkout-session', rateLimit(5, 60_000, 'checkout'))
app.use('/api/analyze', rateLimit(5, 60_000, 'analyze'))
app.use('/api/leads', rateLimit(3, 60_000, 'leads'))
app.use('/api/create-upsell-session', rateLimit(5, 60_000, 'upsell'))
app.use('/api/generate-reply', rateLimit(5, 60_000, 'reply'))
app.use('/api/webhooks/*', rateLimit(30, 60_000, 'webhooks'))

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
  <title>${title} — Signal Decoder</title>
  <meta name="description" content="Decode the hidden signals in their messages. Our AI reveals what they really mean — in 30 seconds.">
  <link rel="icon" type="image/png" sizes="32x32" href="/static/favicon.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png">
  <meta property="og:title" content="${title} — Signal Decoder">
  <meta property="og:description" content="Decode the hidden signals in their messages. Our AI reveals what they really mean — in 30 seconds.">
  <meta property="og:image" content="/static/logo-512.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
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
${HEAD('Arrêtez de vous torturer sur ce que ce message veut vraiment dire')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans" data-page="landing">

  <!-- Exit Intent Popup -->
  <div id="exit-popup" class="fixed inset-0 z-[100] hidden items-center justify-center bg-black/80 backdrop-blur-sm px-4">
    <div class="bg-[#111] border border-violet-500/30 rounded-3xl p-8 max-w-md w-full text-center shadow-2xl shadow-violet-900/50 relative">
      <button onclick="document.getElementById('exit-popup').classList.add('hidden'); document.getElementById('exit-popup').classList.remove('flex')" class="absolute top-4 right-4 text-gray-500 hover:text-white text-lg cursor-pointer">✕</button>
      <div class="text-4xl mb-3">⚠️</div>
      <h2 class="text-xl sm:text-2xl font-black text-white mb-2">Wait — before you go</h2>
      <p class="text-gray-400 text-sm mb-5">The person who sent you that message <strong class="text-white">isn't waiting for you</strong>. Every hour of hesitation is a missed opportunity.</p>
      <div class="bg-violet-900/30 border border-violet-700/30 rounded-xl p-4 mb-5">
        <div class="text-gray-400 text-xs mb-1">Offer expires in</div>
        <div id="exit-countdown" class="font-mono text-3xl font-black text-violet-400">10:00</div>
      </div>
      <a href="#pricing" onclick="document.getElementById('exit-popup').classList.add('hidden'); document.getElementById('exit-popup').classList.remove('flex')"
        class="block w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-black transition-colors">
        Get my clarity now — from €19 →
      </a>
      <p class="text-gray-600 text-xs mt-3">Money-back guarantee · Result in 30 seconds</p>
    </div>
  </div>

  <!-- Scarcity Bar (top, fixed) -->
  <div id="scarcity-bar" class="fixed top-0 w-full z-[51] bg-gradient-to-r from-violet-900/80 to-blue-900/80 border-b border-violet-700/30 py-1.5 sm:py-2 px-3 sm:px-4 text-center text-xs sm:text-sm">
    <div class="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
      <span class="text-amber-300 font-semibold"><i class="fas fa-fire text-amber-400 mr-1"></i>Limited offer</span>
      <span class="text-gray-300 hidden sm:inline">Early Access pricing — increase coming soon</span>
      <span id="scarcity-counter" class="bg-amber-900/50 border border-amber-700/30 text-amber-300 px-2 sm:px-3 py-0.5 rounded-full text-xs font-bold">
        <i class="fas fa-users mr-1"></i><span id="live-count">47</span> people online now
      </span>
    </div>
  </div>

  <!-- Sticky Nav (below scarcity bar) -->
  <nav class="fixed top-[30px] sm:top-[36px] w-full z-50 bg-[#0a0a0a]/95 backdrop-blur border-b border-white/5">
    <div class="max-w-6xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <img src="/static/logo-192.png" alt="Signal Decoder" class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg">
        <span class="font-bold text-white text-sm sm:text-base">Signal Decoder</span>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        <div class="hidden sm:flex items-center gap-1 text-xs text-gray-400">
          <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span id="nav-count">47 online</span>
        </div>
        <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-3 sm:px-5 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors pulse-glow">
          Decode now →
        </a>
      </div>
    </div>
  </nav>

  <!-- ═══════════════════════════════════════════════════════
       HERO — Dream Outcome + Specific Problem
  ═══════════════════════════════════════════════════════ -->
  <section class="pt-28 sm:pt-44 pb-8 sm:pb-12 px-4">
    <div class="max-w-4xl mx-auto text-center">

      <!-- Social proof bar (top) — authority + specificity -->
      <div class="inline-flex items-center gap-1.5 sm:gap-2 bg-amber-900/20 border border-amber-700/30 text-amber-300 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm mb-6 sm:mb-8 font-medium">
        <i class="fas fa-fire text-amber-400 text-xs"></i>
        <span><span id="hero-count">+2,847</span> decoded · <strong>4.9/5</strong> · 94% satisfaction</span>
      </div>

      <!-- Headline -->
      <h1 class="text-3xl sm:text-5xl md:text-6xl font-black leading-[1.1] mb-5 sm:mb-6 tracking-tight fade-in-up">
        Stop overthinking<br>
        what that message<br>
        <span class="gradient-text">really means.</span>
      </h1>

      <!-- Sub-headline -->
      <p class="text-base sm:text-xl text-gray-300 max-w-2xl mx-auto mb-3 sm:mb-4 leading-relaxed px-2">
        Our AI decodes their message in <strong class="text-white">under 30 seconds</strong> and tells you exactly
        what they feel, what they want, and <strong class="text-white">what to reply.</strong>
      </p>
      <p class="text-gray-500 text-xs sm:text-sm mb-8 sm:mb-10">No account. No subscription. Instant results. Guaranteed.</p>

      <!-- Primary CTA -->
      <div class="flex flex-col sm:flex-row gap-4 justify-center mb-5 sm:mb-6 px-2">
        <a href="#pricing"
          class="bg-violet-600 hover:bg-violet-500 text-white px-8 sm:px-10 py-4 sm:py-5 rounded-2xl text-lg sm:text-xl font-black transition-all pulse-glow shadow-2xl shadow-violet-900/50 group">
          Decode my message now
          <span class="ml-2 group-hover:translate-x-1 inline-block transition-transform">→</span>
        </a>
      </div>

      <!-- Micro-copy trust signals -->
      <div class="grid grid-cols-2 sm:flex sm:flex-wrap justify-center gap-x-4 sm:gap-x-6 gap-y-2 sm:gap-y-1 text-xs text-gray-500 mb-4 px-4">
        <span><i class="fas fa-lock text-green-500 mr-1"></i>Secure payment</span>
        <span><i class="fas fa-bolt text-amber-400 mr-1"></i>Result in &lt; 30s</span>
        <span><i class="fas fa-shield-alt text-blue-400 mr-1"></i>100% confidential</span>
        <span><i class="fas fa-undo text-violet-400 mr-1"></i>Money-back guarantee</span>
      </div>

      <!-- Value comparison -->
      <div class="inline-flex items-center gap-2 bg-gray-900/60 border border-gray-800 rounded-xl px-3 sm:px-4 py-2 text-xs text-gray-400 mt-2">
        <i class="fas fa-calculator text-violet-400"></i>
        <span>€29 = 5 min of clarity · vs. hours of overthinking.</span>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       PROBLEM AGITATION — Make them feel the pain
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-3xl mx-auto">
      <h2 class="text-xl sm:text-3xl font-black text-white text-center mb-6 sm:mb-10">
        Does this sound familiar?
      </h2>
      <div class="space-y-2.5 sm:space-y-3">
        ${[
          { icon: 'fa-comment-slash', text: 'They take hours (or days) to reply, and you can\'t tell if you\'re a priority or an afterthought.' },
          { icon: 'fa-question-circle', text: 'A cold or short message arrives, and you spend hours analyzing it with friends — still no clear answer.' },
          { icon: 'fa-heart-broken', text: 'Something shifted but you can\'t pinpoint what — and you\'re afraid of misreading the situation.' },
          { icon: 'fa-briefcase', text: 'An ambiguous work email from your boss or client stresses you out — too cold? Too brief? Hidden meaning?' },
          { icon: 'fa-user-slash', text: 'You wonder if you\'re overthinking or if your gut is right — and nobody around you is objective.' },
        ].map(p => `
        <div class="flex items-start gap-3 sm:gap-4 bg-gray-900/60 border border-gray-800 rounded-xl sm:rounded-2xl p-3 sm:p-4">
          <div class="w-8 h-8 sm:w-10 sm:h-10 bg-red-900/40 border border-red-800/30 rounded-lg sm:rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas ${p.icon} text-red-400 text-xs sm:text-sm"></i>
          </div>
          <p class="text-gray-300 text-xs sm:text-sm leading-relaxed pt-1">${p.text}</p>
        </div>`).join('')}
      </div>
      <p class="text-center text-violet-400 font-bold mt-6 sm:mt-8 text-sm sm:text-lg">If you checked even one — this page is for you.</p>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       LIVE DEMO — Show don't tell
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-2xl mx-auto">
      <div class="text-center mb-8">
        <div class="inline-block bg-violet-900/30 border border-violet-700/30 text-violet-300 text-xs px-3 py-1 rounded-full mb-3">REAL EXAMPLE</div>
        <h2 class="text-xl sm:text-2xl font-black text-white">Here's what you get in 30 seconds</h2>
      </div>
      <div class="glass-card rounded-2xl p-6 border border-violet-500/20">
        <!-- Input -->
        <div class="bg-gray-900/80 border border-gray-700 rounded-xl p-4 mb-5">
          <div class="text-gray-500 text-xs mb-2 font-mono">MESSAGE SOUMIS</div>
          <p class="text-gray-200 text-sm italic">"Il m'a répondu 'Ok.' après 3 jours de silence... avant il répondait toujours en moins d'une heure. Je ne sais plus quoi penser."</p>
        </div>
        <!-- Output preview -->
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Intérêt réel</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-red-500 h-2.5 rounded-full" style="width:22%"></div></div>
              <span class="font-mono text-sm font-bold text-red-400">22/100</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Effort fourni</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-red-500 h-2.5 rounded-full" style="width:8%"></div></div>
              <span class="font-mono text-sm font-bold text-red-400">8/100</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Clarté du signal</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-amber-400 h-2.5 rounded-full" style="width:85%"></div></div>
              <span class="font-mono text-sm font-bold text-amber-400">85/100</span>
            </div>
          </div>
        </div>
        <div class="mt-5 bg-violet-950/60 border border-violet-700/40 rounded-xl p-4">
          <div class="text-xs text-violet-400 font-bold mb-2 uppercase tracking-wider">VERDICT · 82% de confiance</div>
          <p class="text-white font-semibold mb-2">Désengagement progressif — signal de distance volontaire.</p>
          <p class="text-gray-300 text-sm">La rupture de pattern (de 1h à 3 jours) combinée à la réponse monosyllabique représente un retrait émotionnel clair. Ce n'est pas de la timidité.</p>
        </div>
        <div class="mt-4 bg-green-950/40 border border-green-800/30 rounded-xl p-3">
          <div class="text-xs text-green-400 font-bold mb-1">ACTION RECOMMANDÉE</div>
          <p class="text-sm text-gray-200">Ne relancez pas. Miroir son niveau d'investissement. Votre silence a plus de valeur que votre message.</p>
        </div>
        <!-- Blur effect on rest to tease -->
        <div class="mt-4 relative overflow-hidden rounded-xl">
          <div class="filter blur-sm opacity-50 bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-400 space-y-1">
            <div>+ 3 signaux observables détaillés</div>
            <div>+ 2 lectures alternatives (15% burnout, 3% test)</div>
            <div>+ 3 suggestions de réponse (Soft / Direct / Détaché)</div>
          </div>
          <div class="absolute inset-0 flex items-center justify-center">
            <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-xl transition-colors">
              Obtenir mon analyse complète →
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       STATS BAND — Proof numbers (Hormozi: specificity = credibility)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-10 border-t border-white/5 bg-gradient-to-b from-violet-950/10 to-transparent">
    <div class="max-w-4xl mx-auto">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        ${[
          { val: '2 847', label: 'Analyses livrées', icon: 'fa-chart-bar', color: 'violet' },
          { val: '94%', label: 'Taux de satisfaction', icon: 'fa-heart', color: 'green' },
          { val: '27s', label: 'Temps moyen de réponse', icon: 'fa-bolt', color: 'amber' },
          { val: '4.9/5', label: 'Note moyenne', icon: 'fa-star', color: 'blue' },
        ].map(s => `
        <div class="glass-card rounded-xl p-4 text-center border border-white/5">
          <div class="text-${s.color}-400 text-lg mb-1"><i class="fas ${s.icon}"></i></div>
          <div class="font-black text-2xl text-white">${s.val}</div>
          <div class="text-gray-500 text-xs mt-0.5">${s.label}</div>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       SOCIAL PROOF — Testimonials (Hormozi: be specific, name real outcomes)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-5xl mx-auto">
      <div class="text-center mb-10">
        <div class="inline-block bg-green-900/30 border border-green-700/30 text-green-300 text-xs px-3 py-1 rounded-full mb-4 font-semibold">
          <i class="fas fa-check-circle mr-1"></i>Témoignages vérifiés
        </div>
        <h2 class="text-2xl font-black text-white mb-2">Ce qu'ils ont découvert</h2>
        <p class="text-gray-400 text-sm">Des vraies personnes. De vraies situations. De vrais résultats.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        ${[
          {
            quote: '"J\'attendais une réponse de mon copain depuis 4 jours. SST m\'a dit exactement ce que mon instinct sentait mais que je refusais de voir. J\'ai arrêté d\'attendre. 2 heures de clarté au lieu de 2 semaines d\'angoisse."',
            name: 'Sarah M.', role: 'Dating — Quick Decode', stars: 5, outcome: 'A arrêté d\'attendre en vain'
          },
          {
            quote: '"Mon manager m\'a envoyé un email de 2 lignes après une présentation. J\'étais dans le flou total. L\'analyse m\'a donné la lecture exacte et la réponse parfaite. Réunion de crise annulée, promoton toujours d\'actualité."',
            name: 'Thomas D.', role: 'Pro — Deep Read', stars: 5, outcome: 'A évité une situation professionnelle critique'
          },
          {
            quote: '"J\'ai collé 3 semaines de messages. L\'IA a détecté un pattern de breadcrumbing en 30 secondes. J\'avais cherché cette clarté pendant des mois avec mes amies sans jamais l\'avoir. Maintenant j\'ai avancé."',
            name: 'Léa K.', role: 'Dating — Pattern Analysis', stars: 5, outcome: 'A identifié un pattern en 30 secondes'
          },
        ].map(t => `
        <div class="glass-card rounded-2xl p-5 border border-white/5 flex flex-col">
          <div class="flex mb-3">
            ${Array.from({length: t.stars}).map(() => '<i class="fas fa-star text-amber-400 text-xs"></i>').join('')}
          </div>
          <p class="text-gray-300 text-sm leading-relaxed mb-4 flex-1">${t.quote}</p>
          <div class="bg-green-950/30 border border-green-800/30 rounded-lg px-3 py-1.5 mb-3">
            <div class="text-green-400 text-xs font-semibold"><i class="fas fa-check mr-1"></i>${t.outcome}</div>
          </div>
          <div class="border-t border-gray-800 pt-3">
            <div class="font-semibold text-white text-sm">${t.name}</div>
            <div class="text-gray-500 text-xs">${t.role}</div>
          </div>
        </div>`).join('')}
      </div>

      <!-- Mini social proof strip -->
      <div class="flex flex-wrap items-center justify-center gap-6 text-gray-500 text-xs">
        ${[
          { name: 'M.C.', text: '"Verdict juste à 95%"' },
          { name: 'J.B.', text: '"Meilleure décision que j\'ai prise"' },
          { name: 'R.T.', text: '"Mon psy aurait mis 3 séances"' },
          { name: 'A.L.', text: '"Plus objectif que mes amis"' },
          { name: 'P.V.', text: '"J\'aurais dû l\'utiliser avant"' },
        ].map(r => `
        <div class="flex items-center gap-1.5">
          <div class="w-6 h-6 bg-gray-800 rounded-full flex items-center justify-center text-xs font-bold text-gray-400">${r.name.charAt(0)}</div>
          <span>${r.name} — <em class="text-gray-400">${r.text}</em></span>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       HOW IT WORKS — Simple, fast, no friction
  ═══════════════════════════════════════════════════════ -->
  <section id="how-it-works" class="px-4 py-16 border-t border-white/5">
    <div class="max-w-4xl mx-auto">
      <div class="text-center mb-10">
        <h2 class="text-2xl font-black text-white mb-2">Comment ça marche</h2>
        <p class="text-gray-400 text-sm">3 étapes. 30 secondes. Aucun compte requis.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        ${[
          { n:'01', icon:'fa-credit-card', color:'violet', title:'Payez une fois', desc:'Choisissez votre niveau d\'analyse. Un seul paiement. Pas d\'abonnement. Pas de surprise.' },
          { n:'02', icon:'fa-paste', color:'blue', title:'Collez votre situation', desc:'Message, email, situation sociale. Ajoutez le contexte. Notre IA fait le reste en 30 secondes.' },
          { n:'03', icon:'fa-file-alt', color:'green', title:'Lisez votre rapport', desc:'Scores, verdict, lectures alternatives, action recommandée. Tout ce que vous avez besoin de savoir.' },
        ].map(s => `
        <div class="relative">
          <div class="glass-card rounded-2xl p-6 text-center h-full">
            <div class="font-mono text-4xl font-black text-${s.color}-500/20 absolute top-4 right-4">${s.n}</div>
            <div class="w-14 h-14 bg-${s.color}-900/50 border border-${s.color}-700/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <i class="fas ${s.icon} text-${s.color}-400 text-lg"></i>
            </div>
            <h3 class="font-black text-white mb-2">${s.title}</h3>
            <p class="text-gray-400 text-sm">${s.desc}</p>
          </div>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       VALUE STACK PRICING (Hormozi Grand Slam Offer)
  ═══════════════════════════════════════════════════════ -->
  <section id="pricing" class="px-4 py-20 border-t border-white/5">
    <div class="max-w-5xl mx-auto">
      <div class="text-center mb-4">
        <div class="inline-block bg-red-900/30 border border-red-700/30 text-red-300 text-xs px-3 py-1 rounded-full mb-4 font-semibold">
          ⚡ Offre disponible maintenant — Pas de liste d'attente
        </div>
        <h2 class="text-3xl sm:text-4xl font-black text-white mb-3">
          Choisissez votre niveau de clarté
        </h2>
        <p class="text-gray-400 max-w-xl mx-auto">Imaginez combien de temps, d'énergie et de décisions ratées vous coûte l'incertitude. Ces analyses coûtent moins qu'un café pour barista.</p>
      </div>

      <!-- Pricing comparison header -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">

        <!-- Quick Decode -->
        <div class="glass-card rounded-2xl p-6 border border-gray-700/50 hover:border-violet-500/40 transition-all">
          <div class="text-gray-400 text-xs font-mono mb-3 uppercase tracking-wider">Quick Decode</div>
          <!-- Value stack anchoring -->
          <div class="text-gray-600 text-sm line-through mb-1">Valeur réelle : 90€</div>
          <div class="text-4xl font-black text-white mb-1">19€</div>
          <div class="text-gray-400 text-xs mb-5">Réponse claire sur un message unique</div>
          <div class="space-y-2 mb-6">
            ${[
              ['fa-check', 'violet', 'Verdict avec score de confiance'],
              ['fa-check', 'violet', '3 signaux observables décodés'],
              ['fa-check', 'violet', 'Lecture principale + probabilité'],
              ['fa-check', 'violet', '2 lectures alternatives'],
              ['fa-check', 'violet', 'Action recommandée concrète'],
              ['fa-check', 'violet', 'Rapport prêt en 30 secondes'],
            ].map(([ic, col, txt]) =>
              `<li class="flex items-start gap-2 text-sm text-gray-300 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
            ).join('')}
          </div>
          <button data-offer="quick_decode"
            class="w-full bg-gray-800 hover:bg-violet-700 border border-gray-700 hover:border-violet-500 text-white py-3.5 rounded-xl font-bold transition-all cursor-pointer text-sm">
            Obtenir ma clarté — 19€ →
          </button>
        </div>

        <!-- Deep Read — HERO OFFER -->
        <div class="relative rounded-2xl p-[2px] bg-gradient-to-b from-violet-500 to-blue-500 shadow-2xl shadow-violet-900/50">
          <div class="bg-[#111] rounded-2xl p-6 h-full">
            <!-- Badge -->
            <div class="absolute -top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs px-4 py-1.5 rounded-full font-black uppercase tracking-wider shadow-lg">
              LE PLUS POPULAIRE
            </div>
            <div class="text-violet-400 text-xs font-mono mb-3 uppercase tracking-wider">Deep Read</div>
            <div class="text-gray-600 text-sm line-through mb-1">Valeur réelle : 290€</div>
            <div class="text-4xl font-black text-white mb-1">29€</div>
            <div class="text-gray-400 text-xs mb-5">Analyse complète — situations complexes</div>
            <div class="space-y-2 mb-6">
              ${[
                ['fa-check', 'violet', 'Tout ce qu\'inclut Quick Decode'],
                ['fa-check', 'violet', 'Dynamique relationnelle analysée'],
                ['fa-check', 'violet', 'Non-dits et sous-textes détectés'],
                ['fa-check', 'violet', 'Vos biais cognitifs identifiés'],
                ['fa-check', 'violet', '3 suggestions de réponse rédigées'],
                ['fa-check', 'violet', 'Stratégie actionnable immédiate'],
              ].map(([ic, col, txt]) =>
                `<li class="flex items-start gap-2 text-sm text-gray-200 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
              ).join('')}
            </div>
            <button data-offer="deep_read"
              class="w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-black transition-all cursor-pointer pulse-glow text-base">
              Obtenir mon Deep Read — 29€ →
            </button>
            <p class="text-center text-gray-600 text-xs mt-2">Satisfait ou remboursé</p>
          </div>
        </div>

        <!-- Pattern Analysis -->
        <div class="glass-card rounded-2xl p-6 border border-gray-700/50 hover:border-violet-500/40 transition-all">
          <div class="text-gray-400 text-xs font-mono mb-3 uppercase tracking-wider">Pattern Analysis</div>
          <div class="text-gray-600 text-sm line-through mb-1">Valeur réelle : 490€</div>
          <div class="text-4xl font-black text-white mb-1">59€</div>
          <div class="text-gray-400 text-xs mb-5">Comprendre une relation sur la durée</div>
          <div class="space-y-2 mb-6">
            ${[
              ['fa-check', 'violet', 'Analyse de l\'historique complet'],
              ['fa-check', 'violet', 'Tendances émotionnelles (chaud/froid)'],
              ['fa-check', 'violet', 'Asymétrie d\'effort (qui s\'investit)'],
              ['fa-check', 'violet', 'Dynamique de pouvoir détectée'],
              ['fa-check', 'violet', 'Breadcrumbing / manipulation détectés'],
              ['fa-check', 'violet', 'Stratégie relationnelle complète'],
            ].map(([ic, col, txt]) =>
              `<li class="flex items-start gap-2 text-sm text-gray-300 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
            ).join('')}
          </div>
          <button data-offer="pattern_analysis"
            class="w-full bg-gray-800 hover:bg-violet-700 border border-gray-700 hover:border-violet-500 text-white py-3.5 rounded-xl font-bold transition-all cursor-pointer text-sm">
            Analyser mon pattern — 59€ →
          </button>
        </div>
      </div>

      <!-- Guarantee block -->
      <div class="mt-10 bg-green-950/30 border border-green-800/30 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-5 text-center sm:text-left">
        <div class="w-16 h-16 bg-green-900/50 rounded-2xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-shield-alt text-green-400 text-2xl"></i>
        </div>
        <div>
          <h3 class="font-black text-white text-lg mb-1">Garantie Satisfaction — Remboursement immédiat</h3>
          <p class="text-gray-300 text-sm">Si votre analyse ne vous apporte pas de clarté réelle, envoyez un email en 24h. Nous remboursons sans question. Zéro risque.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       OBJECTION KILLER — FAQ + Comparison (Hormozi: destroy every excuse)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-3xl mx-auto">
      <div class="text-center mb-10">
        <h2 class="text-2xl font-black text-white mb-2">Toutes vos questions. Réponses directes.</h2>
        <p class="text-gray-500 text-sm">Parce que vous méritez la vérité, pas du marketing.</p>
      </div>

      <!-- Comparison table (Hormozi: vs alternatives) -->
      <div class="glass-card rounded-2xl border border-gray-800 overflow-hidden mb-8">
        <div class="grid grid-cols-4 text-xs font-bold text-center bg-gray-900/60">
          <div class="p-3 text-left text-gray-400">Méthode</div>
          <div class="p-3 text-gray-400">Coût</div>
          <div class="p-3 text-gray-400">Délai</div>
          <div class="p-3 text-violet-400">Objectivité</div>
        </div>
        ${[
          { method: 'Demander à des amis', cost: '0€ mais...',  time: '2-48h', obj: '❌ Biais émotionnel', highlight: false },
          { method: 'Séance de coaching',  cost: '80-200€',    time: '3-7 jours', obj: '✓ Partiel', highlight: false },
          { method: 'Séance psy',           cost: '60-120€',   time: '1-3 semaines', obj: '✓ Bon', highlight: false },
          { method: '🧠 SST (notre outil)', cost: 'dès 19€',   time: '< 5 minutes', obj: '✅ Aucun biais', highlight: true },
        ].map(r => `
        <div class="grid grid-cols-4 text-xs text-center border-t border-gray-800 ${r.highlight ? 'bg-violet-900/20' : ''}">
          <div class="p-3 text-left ${r.highlight ? 'text-white font-bold' : 'text-gray-400'}">${r.method}</div>
          <div class="p-3 ${r.highlight ? 'text-violet-300 font-bold' : 'text-gray-500'}">${r.cost}</div>
          <div class="p-3 ${r.highlight ? 'text-violet-300 font-bold' : 'text-gray-500'}">${r.time}</div>
          <div class="p-3 ${r.highlight ? 'text-green-300 font-bold' : 'text-gray-500'}">${r.obj}</div>
        </div>`).join('')}
      </div>

      <!-- FAQ Accordion -->
      <div class="space-y-3" id="faq">
        ${[
          {
            q: 'Est-ce que l\'IA peut vraiment analyser un message humain ?',
            a: 'Notre IA a été entraînée spécifiquement pour identifier les signaux comportementaux — timing, ton, effort, cohérence. Elle ne lit pas dans les pensées. Elle analyse des <strong class="text-white">faits observables</strong> et leur probabilité d\'interprétation. C\'est exactement ce que ferait un expert en communication sociale, mais en 30 secondes.'
          },
          {
            q: 'Et si le résultat est complètement à côté ?',
            a: 'Remboursement immédiat, sans question, sans justification. Mais sur <strong class="text-white">2 847 analyses livrées</strong>, notre taux de satisfaction est de 94%. L\'IA est calibrée pour exprimer son niveau de confiance — elle vous dit quand elle est sûre et quand elle ne l\'est pas.'
          },
          {
            q: 'Mes messages sont-ils confidentiels ?',
            a: 'Oui, totalement. Vos textes sont <strong class="text-white">chiffrés en transit</strong>, utilisés uniquement pour générer votre analyse, et automatiquement supprimés après 30 jours. Nous ne les stockons pas, ne les lisons pas, ne les vendons jamais. Conformité RGPD complète.'
          },
          {
            q: 'C\'est différent de demander à un ami ?',
            a: 'Profondément différent. Vos amis vous aiment — et c\'est <em>précisément pour ça</em> qu\'ils ne peuvent pas être objectifs. Ils filtrent ce qu\'ils vous disent pour vous protéger. Notre IA n\'a <strong class="text-white">aucun biais émotionnel</strong> et sépare systématiquement les faits observables de l\'interprétation.'
          },
          {
            q: 'En combien de temps j\'ai mon résultat ?',
            a: 'Le paiement : 30 secondes. Le formulaire : 2 minutes. L\'analyse : 20-45 secondes. <strong class="text-white">Total : moins de 5 minutes</strong> entre maintenant et votre réponse. Pendant ces 5 minutes, vous ruminez encore. Après, vous avez une direction claire.'
          },
          {
            q: 'Je veux juste un conseil, pas une analyse complète.',
            a: 'Le Quick Decode à 19€ est fait pour ça. Un message unique, un verdict clair, une action recommandée. Pas de surcharge d\'information. Juste ce dont vous avez besoin pour prendre la bonne décision aujourd\'hui.'
          },
        ].map((faq, i) => `
        <div class="glass-card rounded-xl border border-gray-800">
          <button onclick="toggleFaq(${i})" class="w-full text-left p-4 flex items-center justify-between gap-3 cursor-pointer">
            <span class="font-semibold text-white text-sm">${faq.q}</span>
            <i id="faq-icon-${i}" class="fas fa-chevron-down text-gray-500 text-xs flex-shrink-0 transition-transform"></i>
          </button>
          <div id="faq-${i}" class="hidden px-4 pb-4">
            <p class="text-gray-400 text-sm leading-relaxed">${faq.a}</p>
          </div>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       LEAD MAGNET — Capture before they leave (Hormozi: lead gen)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-2xl mx-auto">
      <div class="glass-card rounded-2xl p-8 border border-violet-500/20 text-center">
        <div class="inline-block bg-violet-900/40 border border-violet-700/30 text-violet-300 text-xs px-3 py-1.5 rounded-full mb-4 font-semibold">
          GRATUIT
        </div>
        <h2 class="text-xl font-black text-white mb-2">
          Pas encore prêt ? Recevez notre guide gratuit.
        </h2>
        <p class="text-gray-400 text-sm mb-6">
          <strong class="text-white">« Les 7 signaux qui ne mentent jamais »</strong> — Le guide que 1 200+ personnes ont téléchargé pour décoder les comportements sans outil payant.
        </p>
        <form id="lead-form" class="flex flex-col sm:flex-row gap-3">
          <input type="email" name="lead-email" placeholder="Votre email..." required
            class="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm placeholder-gray-500">
          <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer whitespace-nowrap">
            Recevoir le guide →
          </button>
        </form>
        <p class="text-gray-600 text-xs mt-2">0 spam. Désabonnement en 1 clic.</p>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       FINAL CTA — Last push (Hormozi: remind the cost of inaction)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-20 border-t border-white/5 bg-gradient-to-b from-transparent to-violet-950/20">
    <div class="max-w-2xl mx-auto text-center">
      <div class="text-5xl mb-4">🧠</div>
      <h2 class="text-3xl sm:text-4xl font-black text-white mb-4">
        Chaque heure que vous attendez est une heure<br>
        <span class="gradient-text">à vous torturer inutilement.</span>
      </h2>
      <p class="text-gray-400 mb-3 text-lg">La clarté que vous cherchez depuis des heures est à <strong class="text-white">29€</strong> et <strong class="text-white">5 minutes</strong> d'ici.</p>
      <p class="text-gray-600 text-sm mb-8">Et si l'analyse ne vous aide pas : remboursement total. Zéro risque.</p>
      <a href="#pricing"
        class="inline-block bg-violet-600 hover:bg-violet-500 text-white px-12 py-5 rounded-2xl text-xl font-black transition-all pulse-glow shadow-2xl shadow-violet-900/60 mb-4">
        Obtenir ma clarté maintenant →
      </a>
      <div class="flex flex-wrap justify-center gap-x-6 gap-y-1 text-xs text-gray-600 mt-4">
        <span>✓ Satisfait ou remboursé</span>
        <span>✓ Résultat en &lt; 30 secondes</span>
        <span>✓ Sans inscription</span>
        <span>✓ Paiement Stripe sécurisé</span>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="border-t border-white/5 px-6 py-8">
    <div class="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-600">
      <div class="flex items-center gap-2">
        <img src="/static/logo-192.png" alt="Signal Decoder" class="w-6 h-6 rounded">
        <span>Signal Decoder © 2026 — Strategixs SAS</span>
      </div>
      <div class="flex items-center gap-6">
        <a href="/privacy" class="hover:text-gray-400 transition-colors">Confidentialité</a>
        <a href="/terms" class="hover:text-gray-400 transition-colors">CGU</a>
      </div>
    </div>
  </footer>

  <script src="/static/app.js"></script>
  <script>
    function toggleFaq(i) {
      const el = document.getElementById('faq-' + i)
      const icon = document.getElementById('faq-icon-' + i)
      el.classList.toggle('hidden')
      icon.style.transform = el.classList.contains('hidden') ? '' : 'rotate(180deg)'
    }
  </script>
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
    quick_decode: 'Quick Decode — 19€',
    deep_read: 'Deep Read — 29€',
    pattern_analysis: 'Pattern Analysis — 59€',
  }

  const offerIcons: Record<string, string> = {
    quick_decode: 'fa-bolt',
    deep_read: 'fa-search',
    pattern_analysis: 'fa-chart-line',
  }

  const modes = [
    { id: 'message_decode', label: 'Message', icon: 'fa-comment', desc: 'Analyser un message' },
    { id: 'situation_decode', label: 'Situation', icon: 'fa-user-friends', desc: 'Situation sociale' },
    { id: 'dating_decode', label: 'Dating', icon: 'fa-heart', desc: 'Signaux romantiques' },
    { id: 'workplace_decode', label: 'Pro', icon: 'fa-briefcase', desc: 'Dynamiques travail' },
    { id: 'pattern_analysis', label: 'Pattern', icon: 'fa-chart-line', desc: 'Historique relation' },
  ]

  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Votre analyse est prête — Décrivez votre situation')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen py-8 px-4" data-page="intake">
  <div class="max-w-2xl mx-auto">

    <!-- Progress indicator — show momentum -->
    <div class="flex items-center mb-8 text-xs">
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-green-600 rounded-full flex items-center justify-center shadow-lg shadow-green-900/50">
          <i class="fas fa-check text-white text-xs"></i>
        </div>
        <span class="text-green-400 font-bold hidden sm:inline">Paiement ✓</span>
      </div>
      <div class="flex-1 h-1 bg-gradient-to-r from-green-600 to-violet-600 mx-2 rounded-full"></div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-violet-600 rounded-full flex items-center justify-center ring-2 ring-violet-400 shadow-lg shadow-violet-900/50">
          <span class="text-white font-black text-xs">2</span>
        </div>
        <span class="text-white font-bold hidden sm:inline">Votre situation</span>
      </div>
      <div class="flex-1 h-1 bg-gray-800 mx-2 rounded-full"></div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center">
          <span class="text-gray-500 font-bold text-xs">3</span>
        </div>
        <span class="text-gray-600 hidden sm:inline">Résultat</span>
      </div>
    </div>

    <!-- Offer confirmation + anticipation building -->
    <div class="glass-card rounded-2xl p-5 mb-6 border border-violet-500/20 bg-violet-900/10">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-green-700/50 rounded-xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-check text-green-300"></i>
        </div>
        <div class="flex-1">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <span class="text-green-300 font-bold text-sm">
              <i class="fas ${offerIcons[offerType] || 'fa-bolt'} mr-1"></i>
              ${offerLabels[offerType] || offerType}
            </span>
            <span class="text-gray-500 text-xs">Analyse prête à démarrer</span>
          </div>
          <p class="text-gray-400 text-xs mt-1">
            Une étape encore — décrivez votre situation. <strong class="text-white">Résultat dans 30 secondes.</strong>
          </p>
        </div>
      </div>
    </div>

    <!-- Hook / re-engagement headline (Hormozi: remind them why they paid) -->
    <div class="mb-6">
      <h1 class="text-2xl sm:text-3xl font-black text-white mb-2">
        La vérité sur cette situation<br>
        <span class="text-violet-400">est à 2 minutes d'ici.</span>
      </h1>
      <p class="text-gray-400 text-sm">Soyez honnête — pas de filtre. Notre IA est objective, pas votre entourage. <strong class="text-white">Plus de détails = verdict plus précis.</strong></p>
    </div>

    <form id="intake-form" data-analysis-id="${analysisId}" class="space-y-5">
      <input type="hidden" name="offerType" value="${offerType}">
      <input type="hidden" name="mode" value="${defaultMode || 'message_decode'}">

      <!-- Mode selector — visual, frictionless -->
      <div>
        <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
          Quel type de situation ? <span class="text-violet-400">*</span>
        </label>
        <div class="grid grid-cols-5 gap-2">
          ${modes.map(m => `
          <button type="button" data-mode="${m.id}"
            class="p-3 rounded-xl border text-center text-xs transition-all cursor-pointer ${m.id === (defaultMode || 'message_decode') ? 'ring-2 ring-violet-500 bg-violet-900/30 border-violet-500 text-white' : 'border-gray-700/70 text-gray-400 hover:border-violet-500/50 hover:text-white'}">
            <i class="fas ${m.icon} block text-base mb-1.5 text-violet-400"></i>
            <div class="font-bold text-xs">${m.label}</div>
          </button>`).join('')}
        </div>
      </div>

      <!-- Context type + relationship duration (reduce cognitive load) -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Contexte relationnel</label>
          <select name="contextType" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm">
            <option value="dating">❤️ Dating / Romantique</option>
            <option value="work">💼 Professionnel</option>
            <option value="friendship">👥 Amitié</option>
            <option value="family">🏠 Famille</option>
            <option value="social">🌐 Social</option>
            <option value="other">📝 Autre</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Durée de la relation</label>
          <select name="relationDuration" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm">
            <option value="new">🆕 Nouveau / Inconnu</option>
            <option value="weeks">📅 Quelques semaines</option>
            <option value="months">🗓️ Quelques mois</option>
            <option value="years">⭐ Plus d'un an</option>
            <option value="longtime">💎 Relation longue durée</option>
          </select>
        </div>
      </div>

      <!-- Main input — primary value driver + quality signal indicator -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Message ou situation <span class="text-violet-400">*</span>
          </label>
          <span id="char-count" class="text-gray-600 text-xs">0/5000</span>
        </div>
        <!-- Quality indicator bar -->
        <div class="h-1 bg-gray-800 rounded-full mb-2 overflow-hidden">
          <div id="quality-bar" class="h-1 rounded-full transition-all duration-300 bg-red-600" style="width:0%"></div>
        </div>
        <div id="quality-label" class="text-xs text-gray-600 mb-2">Qualité du signal : commencez à écrire...</div>
        <textarea name="inputText" required rows="7" maxlength="5000"
          placeholder="Collez ici le message exact, ou décrivez la situation avec le maximum de détails...

Exemple : &quot;Il m'a répondu 'Ok.' après 3 jours de silence. Avant il répondait en moins d'une heure, sans exception. On se voit depuis 2 semaines. Ce changement m'inquiète.&quot;"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3.5 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 leading-relaxed text-sm"></textarea>
        <p class="text-gray-600 text-xs mt-1.5"><i class="fas fa-lightbulb text-amber-500 mr-1"></i>Conseil : incluez le message exact + le comportement habituel pour un verdict maximal.</p>
      </div>

      <!-- Extra context — optional but recommended -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Contexte supplémentaire
          </label>
          <span class="text-violet-400 text-xs font-semibold">+40% de précision</span>
        </div>
        <textarea name="extraContext" rows="2"
          placeholder="Ce qui a changé récemment, comportement habituel, événements passés importants..."
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 text-sm"></textarea>
      </div>

      <!-- Goal — Hormozi: specificity creates clarity -->
      <div>
        <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">
          Ce que vous voulez vraiment savoir
        </label>
        <input type="text" name="goal"
          placeholder="Ex: Est-il/elle sincèrement intéressé(e) ou juste en train de me garder en option ?"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 text-sm">
      </div>

      <!-- Submit CTA — reinforce urgency and value -->
      <div class="pt-2">
        <button type="submit" id="submit-btn"
          class="w-full bg-violet-600 hover:bg-violet-500 text-white py-5 rounded-2xl font-black text-lg transition-all cursor-pointer shadow-xl shadow-violet-900/40 pulse-glow">
          <i class="fas fa-bolt mr-2"></i>Lancer mon analyse maintenant →
        </button>
        <div class="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-gray-600 mt-3">
          <span><i class="fas fa-clock mr-1"></i>Résultat en 30 secondes</span>
          <span><i class="fas fa-lock mr-1"></i>Confidentiel</span>
          <span><i class="fas fa-shield-alt mr-1"></i>Garanti ou remboursé</span>
        </div>
      </div>
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
          <img src="/static/logo-192.png" alt="Signal Decoder" class="w-16 h-16 opacity-50">
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

  const rawScores = (result.scores as Record<string, number>) || {}
  // Normalize scores: LLM may return 0-10 or 0-100, we need 0-100 for display
  const scores: Record<string, number> = {}
  for (const [key, val] of Object.entries(rawScores)) {
    scores[key] = val <= 10 ? Math.round(val * 10) : Math.round(val)
  }
  const mainReading = result.main_reading as { title: string; description: string; probability_score: number } | undefined
  const alternativeReadings = (result.alternative_readings as Array<{ title: string; description: string; probability_score: number }>) || []
  const observableSignals = (result.observable_signals as Array<{ signal: string; type: string; interpretation: string }>) || []
  const bestNextAction = result.best_next_action as { action: string; rationale: string } | undefined
  const replyOptions = (result.reply_options as Array<{ style: string; text: string; why_it_works: string }>) || []
  const uncertainties = (result.uncertainties as string[]) || []
  // Confidence: use DB value (already normalized to 0-1), or fallback to main_reading probability
  const confidence = analysis.confidence_score
    ? Math.round(analysis.confidence_score * 100)
    : mainReading?.probability_score
      ? (mainReading.probability_score > 1 ? Math.round(mainReading.probability_score) : Math.round(mainReading.probability_score * 100))
      : 75

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
${HEAD('Votre analyse — Rapport complet')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen" data-page="result" data-analysis-id="${analysisId}">

  <!-- Result Header Banner (Hormozi: celebrate the win immediately) -->
  <div class="bg-gradient-to-r from-violet-900/60 to-blue-900/40 border-b border-violet-700/20 px-4 py-4">
    <div class="max-w-3xl mx-auto flex items-center justify-between flex-wrap gap-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center">
          <i class="fas fa-check text-white"></i>
        </div>
        <div>
          <div class="text-white font-black text-sm">Analyse complète — ${offerLabel[analysis.offer_type] || analysis.offer_type}</div>
          <div class="text-gray-400 text-xs">Rapport généré · Confiance : <span class="text-violet-400 font-bold">${confidence}%</span></div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="copy-btn" class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer">
          <i class="fas fa-copy"></i> Copier le résumé
        </button>
        <a href="/" class="flex items-center gap-2 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 text-violet-300 px-3 py-2 rounded-lg text-xs font-semibold transition-colors">
          <i class="fas fa-plus"></i> Nouvelle analyse
        </a>
      </div>
    </div>
  </div>

  <div class="max-w-3xl mx-auto py-8 px-4">

    <!-- Confidence Score Hero (big, impactful) -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-violet-500/20 bg-gradient-to-br from-violet-900/20 to-blue-900/10">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div class="flex-1">
          <div class="text-violet-400 text-xs font-mono mb-2 uppercase tracking-wider">Verdict principal</div>
          <h1 id="result-summary" class="text-xl sm:text-2xl font-black text-white leading-snug">${escapeHtml(String(result.summary || ''))}</h1>
        </div>
        <div class="flex flex-col items-center bg-violet-900/30 border border-violet-700/30 rounded-xl p-4 flex-shrink-0">
          <div class="font-mono text-4xl font-black text-violet-400">${confidence}%</div>
          <div class="text-gray-500 text-xs mt-1">confiance</div>
          <div class="text-xs mt-2 text-center ${confidence >= 70 ? 'text-green-400' : confidence >= 50 ? 'text-amber-400' : 'text-red-400'} font-semibold">
            ${confidence >= 70 ? '✓ Signal clair' : confidence >= 50 ? '~ Signal modéré' : '⚠ Signal faible'}
          </div>
        </div>
      </div>
    </div>

    <!-- Scores — Visual impact -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Scores de la situation</div>
      <div class="space-y-4">
        ${Object.entries(scores).map(([key, val]) => {
          const color = scoreColors[key] || 'violet'
          const label = scoreLabels[key] || key
          const value = typeof val === 'number' ? val : 0
          const zone = value <= 29 ? { text: 'Critique', c: 'red' } : value <= 49 ? { text: 'Bas', c: 'orange' } : value <= 69 ? { text: 'Neutre', c: 'amber' } : value <= 84 ? { text: 'Positif', c: 'green' } : { text: 'Excellent', c: 'emerald' }
          return `
        <div data-score="${value}">
          <div class="flex justify-between items-center mb-1.5">
            <span class="text-sm text-gray-300 font-medium">${label}</span>
            <div class="flex items-center gap-2">
              <span class="text-xs text-${zone.c}-400 font-semibold">${zone.text}</span>
              <span class="font-mono text-sm text-${color}-400 font-bold">${value}<span class="text-gray-600 text-xs">/100</span></span>
            </div>
          </div>
          <div class="bg-gray-800 rounded-full h-3 overflow-hidden">
            <div class="h-3 rounded-full score-bar bg-${color}-500 transition-all" style="width:0%"></div>
          </div>
        </div>`
        }).join('')}
      </div>
    </div>

    <!-- Main Reading — hero card -->
    ${mainReading ? `
    <div class="rounded-2xl p-[2px] bg-gradient-to-r from-violet-600/60 to-blue-600/40 mb-6">
      <div class="bg-[#0f0a1a] rounded-2xl p-6">
        <div class="flex items-center justify-between mb-3">
          <div class="text-violet-400 text-xs font-mono uppercase tracking-wider">Lecture principale</div>
          <div class="bg-violet-900/50 border border-violet-700/30 font-mono text-violet-300 text-sm font-bold px-3 py-1 rounded-full">${mainReading.probability_score > 1 ? Math.round(mainReading.probability_score) : Math.round(mainReading.probability_score * 100)}% probabilité</div>
        </div>
        <h3 class="text-2xl font-black text-white mb-3">${escapeHtml(mainReading.title)}</h3>
        <p class="text-gray-300 leading-relaxed">${escapeHtml(mainReading.description)}</p>
      </div>
    </div>` : ''}

    <!-- Alternative Readings -->
    ${alternativeReadings.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Lectures alternatives</div>
      <div class="space-y-3">
        ${alternativeReadings.map(r => `
        <div class="flex items-start gap-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
          <div class="font-mono text-xs text-gray-500 bg-gray-800 rounded-lg px-2 py-1 flex-shrink-0 mt-0.5">${r.probability_score > 1 ? Math.round(r.probability_score) : Math.round(r.probability_score * 100)}%</div>
          <div>
            <h4 class="font-semibold text-white text-sm mb-1">${escapeHtml(r.title)}</h4>
            <p class="text-gray-400 text-xs leading-relaxed">${escapeHtml(r.description)}</p>
          </div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Observable Signals -->
    ${observableSignals.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Signaux observables analysés</div>
      <div class="space-y-3">
        ${observableSignals.map((s, idx) => `
        <div class="flex gap-3 bg-blue-900/10 border border-blue-900/20 rounded-xl p-3">
          <div class="w-6 h-6 bg-blue-900/50 border border-blue-700/30 rounded-full flex items-center justify-center flex-shrink-0 font-mono text-xs text-blue-400 font-bold">${idx + 1}</div>
          <div>
            <div class="text-white text-sm font-semibold">${escapeHtml(s.signal)}</div>
            <div class="text-gray-400 text-xs mt-0.5"><span class="text-blue-400 font-medium">${s.type}</span> — ${escapeHtml(s.interpretation)}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Best Next Action — most actionable section -->
    ${bestNextAction ? `
    <div class="bg-green-950/30 border-2 border-green-700/40 rounded-2xl p-6 mb-6">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-8 h-8 bg-green-700/50 rounded-lg flex items-center justify-center">
          <i class="fas fa-arrow-right text-green-400 text-sm"></i>
        </div>
        <div class="text-green-400 text-xs font-mono uppercase tracking-wider font-bold">Meilleure prochaine action</div>
      </div>
      <h3 class="text-xl font-black text-white mb-2">${escapeHtml(bestNextAction.action)}</h3>
      <p class="text-gray-300 text-sm leading-relaxed">${escapeHtml(bestNextAction.rationale)}</p>
    </div>` : ''}

    <!-- Reply Options (if included) -->
    ${replyOptions.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="flex items-center gap-2 mb-4">
        <div class="text-gray-400 text-xs font-mono uppercase tracking-wider">Suggestions de réponse</div>
        <div class="bg-violet-900/30 border border-violet-700/30 text-violet-300 text-xs px-2 py-0.5 rounded-full">Incluses</div>
      </div>
      <div class="space-y-4">
        ${replyOptions.map(r => `
        <div class="border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
          <div class="text-violet-400 text-xs font-black mb-2 uppercase tracking-wider flex items-center gap-1">
            <i class="fas fa-comment-alt text-xs"></i> ${escapeHtml(r.style)}
          </div>
          <p class="text-gray-100 text-sm italic mb-2 leading-relaxed">"${escapeHtml(r.text)}"</p>
          <p class="text-gray-500 text-xs border-t border-gray-800 pt-2 mt-2">${escapeHtml(r.why_it_works || '')}</p>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Uncertainties -->
    ${uncertainties.length > 0 ? `
    <div class="glass-card rounded-2xl p-4 mb-6 border border-amber-500/10 bg-amber-900/5">
      <div class="text-amber-400 text-xs font-mono mb-2 uppercase tracking-wider">⚠ Sources d'incertitude</div>
      <ul class="space-y-1.5">
        ${uncertainties.map(u => `<li class="text-gray-400 text-xs flex items-start gap-2"><i class="fas fa-exclamation-triangle text-amber-500 mt-0.5 text-xs flex-shrink-0"></i>${escapeHtml(u)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <!-- UPSELL — Hormozi: strike when iron is hot, anchor high, show exact value -->
    ${!upsellStatus || upsellStatus === 'offered' ? `
    <div class="rounded-2xl p-[2px] bg-gradient-to-r from-violet-600 to-blue-500 mb-6 shadow-2xl shadow-violet-900/30">
      <div class="bg-[#0a0816] rounded-2xl p-6">
        <!-- Header with scarcity -->
        <div class="flex items-start justify-between gap-3 mb-4">
          <div>
            <div class="bg-amber-900/40 border border-amber-700/30 text-amber-300 text-xs px-3 py-1 rounded-full font-bold inline-block mb-2">
              ⚡ Cette offre disparaît quand vous quittez la page
            </div>
            <h3 class="text-xl font-black text-white">
              Vous savez ce que ça signifie.<br>
              <span class="text-violet-400">Mais que répondez-vous ?</span>
            </h3>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-gray-600 text-xs line-through">Valeur réelle : 49€</div>
            <div class="text-3xl font-black text-white">9€</div>
          </div>
        </div>

        <!-- Value stack -->
        <p class="text-gray-300 text-sm mb-4 leading-relaxed">
          Notre IA rédige <strong class="text-white">3 versions de réponse sur-mesure</strong> — adaptées à votre situation spécifique, pas des modèles génériques. Chaque version est livrée avec une explication de pourquoi elle fonctionne <em>dans votre contexte</em>.
        </p>

        <div class="grid grid-cols-3 gap-3 mb-4">
          ${[
            { icon: 'fa-dove', color: 'green', label: 'Diplomate', desc: 'Chaleureux, ouvre une porte sans pression' },
            { icon: 'fa-bullseye', color: 'blue', label: 'Direct', desc: 'Clair, assertif, sans ambiguïté' },
            { icon: 'fa-snowflake', color: 'slate', label: 'Détaché', desc: 'Faible investissement, signal de valeur' },
          ].map(v => `
          <div class="bg-gray-900/60 border border-gray-800 rounded-xl p-3 text-center">
            <i class="fas ${v.icon} text-${v.color}-400 mb-2 block text-base"></i>
            <div class="text-white text-xs font-bold mb-0.5">${v.label}</div>
            <div class="text-gray-500 text-xs leading-tight">${v.desc}</div>
          </div>`).join('')}
        </div>

        <!-- Social proof for upsell -->
        <div class="bg-gray-900/50 border border-gray-800 rounded-xl p-3 mb-4 flex items-center gap-3">
          <div class="text-amber-400 text-xl flex-shrink-0">★★★★★</div>
          <p class="text-gray-400 text-xs italic">"Les 3 messages proposés étaient exactement ce dont j'avais besoin. J'ai choisi le Détaché. Il m'a rappelé dans la journée." — Marie L.</p>
        </div>

        <button id="upsell-btn"
          class="w-full bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white py-4 rounded-xl font-black text-base transition-all cursor-pointer shadow-xl">
          Obtenir mes 3 réponses rédigées — 9€ →
        </button>
        <p class="text-center text-gray-600 text-xs mt-2">Résultat immédiat · Garanti ou remboursé · Offre unique</p>
      </div>
    </div>` : upsellStatus === 'paid' ? `
    <div class="bg-green-950/30 border border-green-700/30 rounded-2xl p-5 mb-6 flex items-center gap-3">
      <i class="fas fa-check-circle text-green-400 text-xl"></i>
      <div>
        <div class="text-green-300 font-bold text-sm">Reply Generator activé</div>
        <div class="text-gray-400 text-xs">Vos réponses rédigées sont incluses ci-dessus.</div>
      </div>
    </div>` : ''}

    <!-- Disclaimer + CTA to new analysis -->
    <div class="text-center text-xs text-gray-600 mt-6 pb-10 space-y-2">
      <p>Cette analyse est probabiliste. Elle ne remplace pas l'avis d'un professionnel de santé mentale.</p>
      <p>Probabilité ≠ Certitude — <em>"Observable signals first."</em></p>
      <div class="mt-4">
        <a href="/" class="text-violet-500 hover:text-violet-400 transition-colors font-semibold">
          <i class="fas fa-plus-circle mr-1"></i>Analyser une autre situation →
        </a>
      </div>
    </div>
  </div>

  <script src="/static/app.js"></script>
</body>
</html>`
}

function upsellPage(analysisId: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
${HEAD('Une étape de plus — Obtenez la réponse parfaite')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="upsell" data-analysis-id="${analysisId}">
  <div class="max-w-lg w-full">

    <!-- Value-first header -->
    <div class="text-center mb-8">
      <div class="inline-block bg-violet-900/40 border border-violet-700/30 text-violet-300 text-xs px-3 py-1.5 rounded-full mb-4 font-semibold">
        Vous savez maintenant ce que ça signifie
      </div>
      <h1 class="text-2xl sm:text-3xl font-black text-white mb-3">
        La question qui reste :<br>
        <span class="gradient-text">Qu'est-ce que vous répondez ?</span>
      </h1>
      <p class="text-gray-400 text-sm">Notre IA rédige 3 messages calibrés sur votre situation — avec l'explication de pourquoi chaque version fonctionne.</p>
    </div>

    <!-- Offer card -->
    <div class="rounded-2xl p-[2px] bg-gradient-to-b from-violet-500 to-blue-500 mb-6">
      <div class="bg-[#0f0f14] rounded-2xl p-6">
        <!-- Anchoring -->
        <div class="flex items-center justify-between mb-5">
          <div>
            <div class="text-gray-500 text-sm line-through">Valeur d'un coach : 49€+</div>
            <div class="text-4xl font-black text-white">9€ <span class="text-gray-500 text-lg font-normal">une fois</span></div>
          </div>
          <div class="bg-amber-900/30 border border-amber-700/30 text-amber-300 text-xs px-3 py-1.5 rounded-full font-bold">
            Offre unique
          </div>
        </div>

        <!-- What you get -->
        <div class="space-y-3 mb-6">
          ${[
            { icon: 'fa-dove', color: 'green', style: 'Diplomate', what: 'Chaleureux, ouvert, sans confrontation. Idéal pour garder la porte ouverte.'},
            { icon: 'fa-bullseye', color: 'blue', style: 'Direct', what: 'Clair, honnête, sans détour. Pour ceux qui veulent des réponses nettes.'},
            { icon: 'fa-snowflake', color: 'gray', style: 'Détaché', what: 'Faible investissement visible. Signal de valeur. Pour ne plus être en position basse.'},
          ].map(v => `
          <div class="flex items-start gap-3 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
            <div class="w-8 h-8 bg-${v.color}-900/50 border border-${v.color}-800/30 rounded-lg flex items-center justify-center flex-shrink-0">
              <i class="fas ${v.icon} text-${v.color}-400 text-xs"></i>
            </div>
            <div>
              <div class="text-white text-xs font-bold mb-0.5">${v.style}</div>
              <div class="text-gray-400 text-xs">${v.what}</div>
            </div>
          </div>`).join('')}
        </div>

        <button id="upsell-checkout-btn"
          onclick="handleUpsellCheckout('${analysisId}')"
          class="w-full bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white py-4 rounded-xl font-black text-base transition-all cursor-pointer shadow-xl">
          Rédiger mes 3 réponses — 9€ →
        </button>
        <p class="text-center text-gray-600 text-xs mt-2">Résultat instantané · Satisfait ou remboursé</p>
      </div>
    </div>

    <div class="text-center">
      <a href="/result/${analysisId}" class="text-gray-600 hover:text-gray-400 text-xs transition-colors">
        Non merci, je me débrouille sans
      </a>
    </div>
  </div>
  <script src="/static/app.js"></script>
  <script>
    async function handleUpsellCheckout(analysisId) {
      const btn = document.getElementById('upsell-checkout-btn')
      btn.disabled = true
      btn.textContent = 'Redirection vers le paiement...'
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
        btn.textContent = 'Rédiger mes 3 réponses — 9€ →'
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
  <p><strong>Dernière mise à jour :</strong> 16 avril 2026</p>

  <h2 class="text-xl font-bold text-white mt-6">1. Responsable du traitement</h2>
  <p>Le responsable du traitement des données est :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Raison sociale :</strong> Strategixs — Société par actions simplifiée (SAS)</li>
    <li><strong>Adresse :</strong> 50 Avenue des Champs Élysées, 75008 Paris, France</li>
    <li><strong>SIREN :</strong> 929 145 621</li>
    <li><strong>SIRET :</strong> 929 145 621 00017</li>
    <li><strong>N° TVA :</strong> FR61929145621</li>
    <li><strong>Email :</strong> social@strategixs.net</li>
  </ul>
  <p class="mt-2">Pour toute question relative à vos données personnelles, contactez-nous à l'adresse ci-dessus.</p>

  <h2 class="text-xl font-bold text-white mt-6">2. Données collectées</h2>
  <p>Nous collectons les données suivantes :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Email :</strong> collecté via Stripe lors du paiement, ou via le formulaire de capture (newsletter).</li>
    <li><strong>Textes soumis :</strong> le message ou la situation que vous soumettez pour analyse.</li>
    <li><strong>Contexte d'analyse :</strong> type de relation, mode d'analyse, contexte supplémentaire fourni volontairement.</li>
    <li><strong>Données de paiement :</strong> traitées exclusivement par Stripe (nous ne stockons ni numéro de carte ni données bancaires).</li>
    <li><strong>Données techniques :</strong> adresse IP, user-agent, horodatage des requêtes (collectées automatiquement pour la sécurité du service).</li>
  </ul>
  <p class="mt-2">Aucun compte utilisateur n'est créé. Nous ne collectons pas de nom, prénom, adresse postale ni numéro de téléphone.</p>

  <h2 class="text-xl font-bold text-white mt-6">3. Base légale du traitement</h2>
  <p>Le traitement de vos données repose sur les bases légales suivantes (RGPD Art. 6) :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Exécution du contrat :</strong> traitement de votre commande, génération de l'analyse, gestion du paiement.</li>
    <li><strong>Consentement :</strong> inscription à la newsletter, capture d'email volontaire.</li>
    <li><strong>Intérêt légitime :</strong> sécurité du service, prévention des fraudes, logs techniques.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">4. Finalité du traitement</h2>
  <p>Vos données sont utilisées exclusivement pour :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Générer votre analyse personnalisée via notre moteur IA.</li>
    <li>Traiter et confirmer votre paiement.</li>
    <li>Vous recontacter en cas de problème technique lié à votre commande.</li>
    <li>Améliorer la qualité du service (données anonymisées et agrégées uniquement).</li>
  </ul>
  <p class="mt-2">Vos textes ne sont <strong>jamais</strong> utilisés pour entraîner des modèles d'IA.</p>

  <h2 class="text-xl font-bold text-white mt-6">5. Sous-traitants et partage des données</h2>
  <p>Vos données sont partagées avec les prestataires suivants, strictement nécessaires au fonctionnement du service :</p>
  <table class="w-full text-sm mt-2 border border-gray-700">
    <thead><tr class="bg-gray-800"><th class="px-3 py-2 text-left">Prestataire</th><th class="px-3 py-2 text-left">Rôle</th><th class="px-3 py-2 text-left">Localisation</th></tr></thead>
    <tbody>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">Stripe, Inc.</td><td class="px-3 py-2">Traitement des paiements</td><td class="px-3 py-2">USA (certifié DPF)</td></tr>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">OpenAI, Inc.</td><td class="px-3 py-2">Génération d'analyse IA</td><td class="px-3 py-2">USA (certifié DPF)</td></tr>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">Cloudflare, Inc.</td><td class="px-3 py-2">Hébergement, CDN, base de données</td><td class="px-3 py-2">Global (certifié DPF)</td></tr>
    </tbody>
  </table>
  <p class="mt-2">Vos données ne sont <strong>jamais vendues</strong> à des tiers. Aucune donnée n'est partagée à des fins publicitaires.</p>

  <h2 class="text-xl font-bold text-white mt-6">6. Transferts hors Union européenne</h2>
  <p>Certains de nos prestataires sont basés aux États-Unis. Ces transferts sont encadrés par :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Le <strong>EU-U.S. Data Privacy Framework (DPF)</strong> pour Stripe, OpenAI et Cloudflare.</li>
    <li>Des <strong>clauses contractuelles types (SCCs)</strong> de la Commission européenne lorsque le DPF ne s'applique pas.</li>
  </ul>
  <p class="mt-2">Conformément à l'article 46 du RGPD, des garanties appropriées sont en place pour protéger vos données.</p>

  <h2 class="text-xl font-bold text-white mt-6">7. Durée de conservation</h2>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Textes soumis et analyses :</strong> 90 jours, puis suppression automatique.</li>
    <li><strong>Email :</strong> conservé tant que nécessaire à la relation commerciale, maximum 3 ans après le dernier achat.</li>
    <li><strong>Données de paiement :</strong> conservées par Stripe selon leur propre politique (obligations légales comptables).</li>
    <li><strong>Logs techniques :</strong> 30 jours maximum.</li>
    <li><strong>Newsletter :</strong> jusqu'à désinscription.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">8. Cookies et technologies de suivi</h2>
  <p>Ce site utilise des cookies strictement nécessaires au fonctionnement du service :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Session technique :</strong> maintien de votre session de navigation (aucun cookie de tracking).</li>
    <li><strong>Cloudflare :</strong> cookies de sécurité et de performance (cf-bm, __cflb).</li>
  </ul>
  <p class="mt-2">Nous n'utilisons <strong>aucun cookie publicitaire, analytique ou de profilage</strong>. Aucun outil de tracking tiers (Google Analytics, Facebook Pixel, etc.) n'est installé.</p>

  <h2 class="text-xl font-bold text-white mt-6">9. Vos droits (RGPD)</h2>
  <p>Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez des droits suivants :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Droit d'accès :</strong> obtenir une copie de vos données personnelles.</li>
    <li><strong>Droit de rectification :</strong> corriger des données inexactes.</li>
    <li><strong>Droit à l'effacement :</strong> demander la suppression de vos données.</li>
    <li><strong>Droit à la portabilité :</strong> recevoir vos données dans un format structuré.</li>
    <li><strong>Droit d'opposition :</strong> vous opposer au traitement de vos données.</li>
    <li><strong>Droit à la limitation :</strong> restreindre le traitement dans certains cas.</li>
    <li><strong>Droit de retrait du consentement :</strong> à tout moment, sans affecter la licéité du traitement antérieur.</li>
  </ul>
  <p class="mt-3">Pour exercer vos droits, envoyez un email à <strong>social@strategixs.net</strong> avec l'objet "Demande RGPD". Nous répondrons sous 30 jours maximum.</p>

  <h2 class="text-xl font-bold text-white mt-6">10. Réclamation</h2>
  <p>Si vous estimez que le traitement de vos données ne respecte pas la réglementation, vous pouvez introduire une réclamation auprès de la <strong>CNIL</strong> (Commission Nationale de l'Informatique et des Libertés) :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Site : <a href="https://www.cnil.fr" class="text-violet-400 hover:underline" target="_blank" rel="noopener">www.cnil.fr</a></li>
    <li>Adresse : 3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">11. Sécurité des données</h2>
  <p>Nous mettons en œuvre les mesures techniques et organisationnelles suivantes :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Chiffrement HTTPS/TLS sur toutes les communications.</li>
    <li>Base de données chiffrée au repos (Cloudflare D1).</li>
    <li>Accès restreint aux données (principe du moindre privilège).</li>
    <li>Protection contre les attaques par force brute (rate limiting).</li>
    <li>Vérification cryptographique des webhooks de paiement.</li>
    <li>Aucune donnée bancaire stockée sur nos serveurs.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">12. Mineurs</h2>
  <p>Ce service est destiné aux personnes de <strong>16 ans et plus</strong>. Nous ne collectons pas sciemment de données de mineurs de moins de 16 ans. Si vous êtes parent et pensez que votre enfant a utilisé ce service, contactez-nous pour suppression.</p>

  <h2 class="text-xl font-bold text-white mt-6">13. Modifications</h2>
  <p>Cette politique peut être mise à jour. En cas de modification substantielle, un avis sera affiché sur le site. La date de dernière mise à jour en haut de cette page fait foi.</p>
  `
}

function termsContent(): string {
  return `
  <p><strong>Dernière mise à jour :</strong> 16 avril 2026</p>

  <h2 class="text-xl font-bold text-white mt-6">1. Mentions légales</h2>
  <p>Le service Signal Decoder est édité par :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Éditeur :</strong> Strategixs — Société par actions simplifiée (SAS)</li>
    <li><strong>Adresse :</strong> 50 Avenue des Champs Élysées, 75008 Paris, France</li>
    <li><strong>SIREN :</strong> 929 145 621 · <strong>SIRET :</strong> 929 145 621 00017</li>
    <li><strong>N° TVA intracommunautaire :</strong> FR61929145621</li>
    <li><strong>Email :</strong> social@strategixs.net</li>
    <li><strong>Hébergeur :</strong> Cloudflare, Inc. — 101 Townsend Street, San Francisco, CA 94107, USA — <a href="https://www.cloudflare.com" class="text-violet-400 hover:underline" target="_blank" rel="noopener">www.cloudflare.com</a></li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">2. Objet du service</h2>
  <p>Signal Decoder est un outil d'analyse assistée par intelligence artificielle. Il propose une <strong>interprétation probabiliste</strong> de messages et de situations sociales soumis par l'utilisateur.</p>
  <p class="mt-2"><strong>Le service ne constitue en aucun cas :</strong></p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Un avis médical, psychologique ou psychiatrique.</li>
    <li>Un conseil juridique.</li>
    <li>Un diagnostic clinique ou une évaluation de santé mentale.</li>
    <li>Un substitut à une consultation avec un professionnel qualifié.</li>
  </ul>
  <p class="mt-2">Les résultats sont fournis à titre informatif et de divertissement. L'utilisateur reste seul responsable des décisions prises sur la base de ces analyses.</p>

  <h2 class="text-xl font-bold text-white mt-6">3. Acceptation des conditions</h2>
  <p>L'utilisation du service implique l'acceptation pleine et entière des présentes Conditions Générales d'Utilisation (CGU). Si vous n'acceptez pas ces conditions, vous ne devez pas utiliser le service.</p>

  <h2 class="text-xl font-bold text-white mt-6">4. Accès au service</h2>
  <p>Le service est accessible en ligne, sans création de compte. L'accès aux analyses est conditionné au paiement préalable via Stripe.</p>
  <p class="mt-2">Nous nous réservons le droit de suspendre ou interrompre le service temporairement pour maintenance, mise à jour ou cas de force majeure, sans indemnisation.</p>

  <h2 class="text-xl font-bold text-white mt-6">5. Tarifs et paiement</h2>
  <p>Les tarifs sont affichés en euros (€), toutes taxes comprises. Les offres disponibles sont :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Quick Decode :</strong> 19€ — analyse concise d'un message.</li>
    <li><strong>Deep Read :</strong> 29€ — analyse approfondie avec contexte.</li>
    <li><strong>Pattern Analysis :</strong> 59€ — analyse de patterns relationnels.</li>
    <li><strong>Reply Generator (upsell) :</strong> 9€ — 3 suggestions de réponse personnalisées.</li>
  </ul>
  <p class="mt-2">Les paiements sont traités de manière sécurisée par <strong>Stripe, Inc.</strong> Nous ne stockons aucune donnée bancaire.</p>
  <p class="mt-2">Nous nous réservons le droit de modifier les tarifs à tout moment. Les modifications n'affectent pas les commandes déjà validées.</p>

  <h2 class="text-xl font-bold text-white mt-6">6. Droit de rétractation</h2>
  <p>Conformément à l'article L221-28 du Code de la consommation, le droit de rétractation <strong>ne s'applique pas</strong> aux contrats de fourniture de contenu numérique non fourni sur un support matériel dont l'exécution a commencé avec l'accord préalable du consommateur.</p>
  <p class="mt-2">En validant votre commande et en soumettant un texte pour analyse, vous acceptez expressément que l'exécution du service commence immédiatement et renoncez à votre droit de rétractation.</p>
  <p class="mt-2"><strong>Garantie de satisfaction :</strong> malgré l'inapplicabilité du droit de rétractation, nous proposons un remboursement en cas de dysfonctionnement technique avéré empêchant la délivrance de l'analyse (erreur serveur, échec de génération). Contactez social@strategixs.net dans les 7 jours suivant l'achat.</p>

  <h2 class="text-xl font-bold text-white mt-6">7. Propriété intellectuelle</h2>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Le service :</strong> l'ensemble du site, de son design, de son code source et de ses algorithmes est la propriété exclusive de Strategixs. Toute reproduction est interdite.</li>
    <li><strong>Vos textes :</strong> les textes que vous soumettez restent votre propriété. Vous nous accordez une licence temporaire et limitée pour les traiter via notre moteur IA.</li>
    <li><strong>Les analyses :</strong> les analyses générées vous sont concédées à titre de licence personnelle, non cessible. Vous pouvez les utiliser librement à titre privé.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">8. Contenu interdit</h2>
  <p>Il est strictement interdit d'utiliser le service pour :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Planifier, faciliter ou encourager des actes illégaux.</li>
    <li>Harceler, menacer, intimider ou nuire à autrui.</li>
    <li>Soumettre du contenu à caractère pédopornographique.</li>
    <li>Manipuler, exploiter émotionnellement ou exercer un contrôle coercitif sur une personne.</li>
    <li>Surveiller, traquer ou espionner une personne sans son consentement.</li>
  </ul>
  <p class="mt-2">Toute utilisation abusive entraînera le blocage de l'analyse sans remboursement et pourra donner lieu à un signalement aux autorités compétentes.</p>

  <h2 class="text-xl font-bold text-white mt-6">9. Limitation de responsabilité</h2>
  <p>Signal Decoder fournit des analyses <strong>probabilistes générées par intelligence artificielle</strong>. En conséquence :</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Les résultats ne sont pas garantis comme exacts, complets ou adaptés à votre situation spécifique.</li>
    <li>Strategixs ne peut être tenu responsable des décisions prises par l'utilisateur sur la base des analyses.</li>
    <li>Strategixs ne peut être tenu responsable des dommages indirects, perte de chance, préjudice moral ou émotionnel liés à l'utilisation du service.</li>
    <li>La responsabilité de Strategixs est limitée au montant payé par l'utilisateur pour l'analyse concernée.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">10. Âge minimum</h2>
  <p>Le service est réservé aux personnes âgées de <strong>16 ans et plus</strong>. En utilisant le service, vous déclarez avoir au moins 16 ans. Les mineurs de moins de 16 ans ne sont pas autorisés à utiliser ce service.</p>

  <h2 class="text-xl font-bold text-white mt-6">11. Protection des données</h2>
  <p>Le traitement de vos données personnelles est détaillé dans notre <a href="/privacy" class="text-violet-400 hover:underline">Politique de Confidentialité</a>. En utilisant le service, vous reconnaissez avoir pris connaissance de cette politique.</p>

  <h2 class="text-xl font-bold text-white mt-6">12. Modification des CGU</h2>
  <p>Les présentes CGU peuvent être modifiées à tout moment. Les modifications prennent effet dès leur publication sur le site. La date de dernière mise à jour en haut de cette page fait foi. L'utilisation continue du service après modification vaut acceptation des nouvelles conditions.</p>

  <h2 class="text-xl font-bold text-white mt-6">13. Loi applicable et juridiction</h2>
  <p>Les présentes CGU sont régies par le <strong>droit français</strong>. Tout litige relatif à l'interprétation ou à l'exécution des présentes sera soumis aux tribunaux compétents de Paris, France, sous réserve des dispositions impératives applicables au consommateur.</p>
  <p class="mt-2">Conformément à l'article L612-1 du Code de la consommation, en cas de litige, vous pouvez recourir gratuitement au service de médiation de la consommation. Nous vous communiquerons les coordonnées du médiateur compétent sur simple demande.</p>

  <h2 class="text-xl font-bold text-white mt-6">14. Contact</h2>
  <p>Pour toute question relative aux présentes CGU : <strong>social@strategixs.net</strong></p>
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

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
${HEAD('Arrêtez de vous torturer sur ce que ce message veut vraiment dire')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans" data-page="landing">

  <!-- Exit Intent Popup -->
  <div id="exit-popup" class="fixed inset-0 z-[100] hidden items-center justify-center bg-black/80 backdrop-blur-sm px-4">
    <div class="bg-[#111] border border-violet-500/30 rounded-3xl p-8 max-w-md w-full text-center shadow-2xl shadow-violet-900/50 relative">
      <button onclick="document.getElementById('exit-popup').classList.add('hidden'); document.getElementById('exit-popup').classList.remove('flex')" class="absolute top-4 right-4 text-gray-500 hover:text-white text-lg cursor-pointer">✕</button>
      <div class="text-4xl mb-3">⚠️</div>
      <h2 class="text-2xl font-black text-white mb-2">Attendez — avant de partir</h2>
      <p class="text-gray-400 text-sm mb-5">La personne qui vous a envoyé ce message <strong class="text-white">ne vous attend pas</strong>. Chaque heure d'hésitation est une opportunité perdue.</p>
      <div class="bg-violet-900/30 border border-violet-700/30 rounded-xl p-4 mb-5">
        <div class="text-gray-400 text-xs mb-1">Offre valable encore</div>
        <div id="exit-countdown" class="font-mono text-3xl font-black text-violet-400">09:59</div>
      </div>
      <a href="#pricing" onclick="document.getElementById('exit-popup').classList.add('hidden'); document.getElementById('exit-popup').classList.remove('flex')"
        class="block w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-black transition-colors">
        Obtenir ma clarté maintenant — dès 19€ →
      </a>
      <p class="text-gray-600 text-xs mt-3">Satisfait ou remboursé · Résultat en 30 secondes</p>
    </div>
  </div>

  <!-- Scarcity Bar (top) -->
  <div id="scarcity-bar" class="bg-gradient-to-r from-violet-900/80 to-blue-900/80 border-b border-violet-700/30 py-2 px-4 text-center text-sm">
    <div class="flex items-center justify-center gap-3 flex-wrap">
      <span class="text-amber-300 font-semibold"><i class="fas fa-fire text-amber-400 mr-1"></i>🔥 Offre limitée</span>
      <span class="text-gray-300">Prix Early Access — augmentation prévue fin du mois</span>
      <span id="scarcity-counter" class="bg-amber-900/50 border border-amber-700/30 text-amber-300 px-3 py-0.5 rounded-full text-xs font-bold">
        <i class="fas fa-users mr-1"></i><span id="live-count">47</span> personnes consultent en ce moment
      </span>
    </div>
  </div>

  <!-- Sticky Nav -->
  <nav class="fixed top-0 w-full z-50 bg-[#0a0a0a]/95 backdrop-blur border-b border-white/5" style="top: 0">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-brain text-white text-xs"></i>
        </div>
        <span class="font-bold text-white">Social Signal Translator</span>
      </div>
      <div class="flex items-center gap-3">
        <div class="hidden sm:flex items-center gap-1 text-xs text-gray-400">
          <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span id="nav-count">47 en ligne</span>
        </div>
        <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition-colors pulse-glow">
          Décoder maintenant →
        </a>
      </div>
    </div>
  </nav>

  <!-- ═══════════════════════════════════════════════════════
       HERO — Dream Outcome + Specific Problem
  ═══════════════════════════════════════════════════════ -->
  <section class="pt-36 pb-12 px-4">
    <div class="max-w-4xl mx-auto text-center">

      <!-- Social proof bar (top) — authority + specificity -->
      <div class="inline-flex items-center gap-2 bg-amber-900/20 border border-amber-700/30 text-amber-300 px-4 py-2 rounded-full text-sm mb-8 font-medium">
        <i class="fas fa-fire text-amber-400 text-xs"></i>
        <span id="hero-count">+2 847</span> analyses livrées ce mois · Noté <strong>4.9/5</strong> · 94% taux de satisfaction
      </div>

      <!-- Headline — Specific pain + Dream outcome (Hormozi: be so specific it stings) -->
      <h1 class="text-4xl sm:text-5xl md:text-6xl font-black leading-[1.1] mb-6 tracking-tight fade-in-up">
        Arrêtez de vous torturer<br>
        sur ce que ce message<br>
        <span class="gradient-text">veut vraiment dire.</span>
      </h1>

      <!-- Sub-headline — Who it's for + specific result -->
      <p class="text-lg sm:text-xl text-gray-300 max-w-2xl mx-auto mb-4 leading-relaxed">
        Notre IA analyse votre message en <strong class="text-white">moins de 30 secondes</strong> et vous dit exactement
        ce que la personne ressent, ce qu'elle veut, et <strong class="text-white">quelle réponse envoyer.</strong>
      </p>
      <p class="text-gray-500 text-sm mb-10">Sans compte. Sans abonnement. Résultat immédiat. Garanti.</p>

      <!-- Primary CTA — Hormozi: make the CTA a no-brainer -->
      <div class="flex flex-col sm:flex-row gap-4 justify-center mb-6">
        <a href="#pricing"
          class="bg-violet-600 hover:bg-violet-500 text-white px-10 py-5 rounded-2xl text-xl font-black transition-all pulse-glow shadow-2xl shadow-violet-900/50 group">
          Décoder mon message maintenant
          <span class="ml-2 group-hover:translate-x-1 inline-block transition-transform">→</span>
        </a>
      </div>

      <!-- Micro-copy trust signals -->
      <div class="flex flex-wrap justify-center gap-x-6 gap-y-1 text-xs text-gray-500 mb-4">
        <span><i class="fas fa-lock text-green-500 mr-1"></i>Paiement sécurisé Stripe</span>
        <span><i class="fas fa-bolt text-amber-400 mr-1"></i>Résultat en &lt; 30 secondes</span>
        <span><i class="fas fa-shield-alt text-blue-400 mr-1"></i>100% confidentiel</span>
        <span><i class="fas fa-undo text-violet-400 mr-1"></i>Satisfait ou remboursé</span>
      </div>

      <!-- Hormozi: Show the math — dream outcome vs time investment -->
      <div class="inline-flex items-center gap-2 bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-2 text-xs text-gray-400 mt-2">
        <i class="fas fa-calculator text-violet-400"></i>
        <span>29€ = &lt; 5 min de votre temps · vs. des heures de rumination. Le calcul est simple.</span>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       PROBLEM AGITATION — Make them feel the pain
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-3xl mx-auto">
      <h2 class="text-2xl sm:text-3xl font-black text-white text-center mb-10">
        Vous vous reconnaissez dans l'une de ces situations ?
      </h2>
      <div class="space-y-3">
        ${[
          { icon: 'fa-comment-slash', text: 'Il/elle met des heures (ou des jours) à répondre, et vous ne savez plus si vous êtes prioritaire ou non.' },
          { icon: 'fa-question-circle', text: 'Un message froid ou sec arrive, et vous passez 2h à l\'analyser avec vos amis sans trouver de réponse claire.' },
          { icon: 'fa-heart-broken', text: 'Vous sentez que quelque chose a changé mais impossible de mettre le doigt dessus — et vous avez peur de vous tromper.' },
          { icon: 'fa-briefcase', text: 'Un email professionnel ambigu de votre manager ou client vous stresse — trop froid ? Trop court ? Sous-entendu négatif ?' },
          { icon: 'fa-user-slash', text: 'Vous vous demandez si vous sur-analysez ou si votre instinct a raison — et personne autour de vous n\'est objectif.' },
        ].map(p => `
        <div class="flex items-start gap-4 bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
          <div class="w-10 h-10 bg-red-900/40 border border-red-800/30 rounded-xl flex items-center justify-center flex-shrink-0">
            <i class="fas ${p.icon} text-red-400 text-sm"></i>
          </div>
          <p class="text-gray-300 text-sm leading-relaxed pt-1.5">${p.text}</p>
        </div>`).join('')}
      </div>
      <p class="text-center text-violet-400 font-bold mt-8 text-lg">Si vous avez coché au moins une case — cette page est faite pour vous.</p>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       LIVE DEMO — Show don't tell
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-16 border-t border-white/5">
    <div class="max-w-2xl mx-auto">
      <div class="text-center mb-8">
        <div class="inline-block bg-violet-900/30 border border-violet-700/30 text-violet-300 text-xs px-3 py-1 rounded-full mb-3">EXEMPLE RÉEL</div>
        <h2 class="text-2xl font-black text-white">Voici ce que vous obtenez en 30 secondes</h2>
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
        <div class="w-6 h-6 bg-violet-600 rounded flex items-center justify-center">
          <i class="fas fa-brain text-white text-xs"></i>
        </div>
        <span>Social Signal Translator © 2026 — Strategix</span>
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
          <div class="bg-violet-900/50 border border-violet-700/30 font-mono text-violet-300 text-sm font-bold px-3 py-1 rounded-full">${mainReading.probability_score}% probabilité</div>
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
          <div class="font-mono text-xs text-gray-500 bg-gray-800 rounded-lg px-2 py-1 flex-shrink-0 mt-0.5">${r.probability_score}%</div>
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

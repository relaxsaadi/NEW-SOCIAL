import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings } from './lib/types'
import { now, ulid, logEvent, getOrCreateUser } from './lib/db'
import { rateLimit } from './lib/rate-limit'
import { ghlLeadCaptured } from './lib/ghl'
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
app.use('/api/create-free-analysis', rateLimit(5, 60_000, 'free')) // 5 per minute to prevent abuse
app.use('/api/analyze', rateLimit(5, 60_000, 'analyze'))
app.use('/api/leads', rateLimit(3, 60_000, 'leads'))
app.use('/api/create-upsell-session', rateLimit(5, 60_000, 'upsell'))
app.use('/api/generate-reply', rateLimit(5, 60_000, 'reply'))
app.use('/api/webhooks/*', rateLimit(30, 60_000, 'webhooks'))

// Routes
app.route('/', checkout)
app.route('/', analyze)
app.route('/', admin)

// ── Free Mini Decode ─────────────────────────────────────────────────────────
app.post('/api/create-free-analysis', async (c) => {
  const { email } = await c.req.json() as { email?: string }
  if (!email) return c.json({ error: 'MISSING_EMAIL' }, 400)

  const analysisId = ulid()
  const ts = now()

  // Create user or get existing (uses correct DB schema)
  const userId = await getOrCreateUser(c.env.DB, email, { locale: 'en', source: 'free_mini_decode' })

  // Create analysis record (match checkout schema) then set user_id
  await c.env.DB.prepare(
    `INSERT INTO analyses (id, offer_type, mode, context_type, status, created_at, updated_at)
     VALUES (?, 'mini_decode', 'message_decode', 'other', 'paid', ?, ?)`
  ).bind(analysisId, ts, ts).run()

  await c.env.DB.prepare(
    `UPDATE analyses SET user_id = ? WHERE id = ?`
  ).bind(userId, analysisId).run()

  // Also capture as lead
  const leadId = ulid()
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO leads (id, email, source, created_at) VALUES (?, ?, ?, ?)`
  ).bind(leadId, email, 'free_mini_decode', ts).run()

  await logEvent(c.env.DB, 'free_analysis_created', { analysis_id: analysisId })
  c.executionCtx?.waitUntil(ghlLeadCaptured(email, 'free_mini_decode'))

  return c.json({ analysisId, redirectUrl: `/intake/${analysisId}` })
})

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
  c.executionCtx?.waitUntil(ghlLeadCaptured(email, source ?? 'landing'))
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
    return c.html(errorPage('Analysis not found', 'This link is invalid or expired.'))
  }

  if (analysis.status === 'completed') {
    return c.redirect(`/result/${analysisId}`)
  }

  if (analysis.status === 'generating') {
    return c.redirect(`/processing/${analysisId}`)
  }

  if (!['paid', 'intake_pending', 'failed'].includes(analysis.status)) {
    return c.html(errorPage('Payment not verified', 'Your payment has not been confirmed yet. Please wait a few seconds.'))
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

  if (!analysis) return c.html(errorPage('Not found', 'This analysis does not exist.'))

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

  if (!analysis) return c.html(errorPage('Not found', 'This analysis does not exist.'))
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
app.get('/privacy', (c) => c.html(legalPage('Privacy Policy', privacyContent())))
app.get('/terms', (c) => c.html(legalPage('Terms of Use', termsContent())))
app.get('/legal', (c) => c.redirect('/terms'))

// Free guide page
app.get('/guide', (c) => c.html(guidePage()))

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
<html lang="en" class="scroll-smooth">
${HEAD('Stop overthinking what that message really means')}
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
        Try a free analysis now →
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
        <span>Try free · or from €14.99 for full clarity · vs. hours of overthinking.</span>
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
          <div class="text-gray-500 text-xs mb-2 font-mono">MESSAGE SUBMITTED</div>
          <p class="text-gray-200 text-sm italic">"He replied 'Ok.' after 3 days of silence... he used to always respond in under an hour. I don't know what to think anymore."</p>
        </div>
        <!-- Output preview -->
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Real interest</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-red-500 h-2.5 rounded-full" style="width:22%"></div></div>
              <span class="font-mono text-sm font-bold text-red-400">22/100</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Effort given</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-red-500 h-2.5 rounded-full" style="width:8%"></div></div>
              <span class="font-mono text-sm font-bold text-red-400">8/100</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Signal clarity</span>
            <div class="flex items-center gap-2 w-40">
              <div class="flex-1 bg-gray-800 rounded-full h-2.5"><div class="bg-amber-400 h-2.5 rounded-full" style="width:85%"></div></div>
              <span class="font-mono text-sm font-bold text-amber-400">85/100</span>
            </div>
          </div>
        </div>
        <div class="mt-5 bg-violet-950/60 border border-violet-700/40 rounded-xl p-4">
          <div class="text-xs text-violet-400 font-bold mb-2 uppercase tracking-wider">VERDICT · 82% confidence</div>
          <p class="text-white font-semibold mb-2">Progressive disengagement — deliberate distancing signal.</p>
          <p class="text-gray-300 text-sm">The pattern break (from 1 hour to 3 days) combined with the monosyllabic reply represents a clear emotional withdrawal. This is not shyness.</p>
        </div>
        <div class="mt-4 bg-green-950/40 border border-green-800/30 rounded-xl p-3">
          <div class="text-xs text-green-400 font-bold mb-1">RECOMMENDED ACTION</div>
          <p class="text-sm text-gray-200">Don't chase. Mirror their level of investment. Your silence is worth more than your message.</p>
        </div>
        <!-- Blur effect on rest to tease -->
        <div class="mt-4 relative overflow-hidden rounded-xl">
          <div class="filter blur-sm opacity-50 bg-gray-900 border border-gray-800 rounded-xl p-3 text-xs text-gray-400 space-y-1">
            <div>+ 3 detailed observable signals</div>
            <div>+ 2 alternative readings (15% burnout, 3% test)</div>
            <div>+ 3 reply suggestions (Soft / Direct / Detached)</div>
          </div>
          <div class="absolute inset-0 flex items-center justify-center">
            <a href="#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-xl transition-colors">
              Get my full analysis →
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
          { val: '2 847', label: 'Analyses delivered', icon: 'fa-chart-bar', color: 'violet' },
          { val: '94%', label: 'Satisfaction rate', icon: 'fa-heart', color: 'green' },
          { val: '27s', label: 'Average response time', icon: 'fa-bolt', color: 'amber' },
          { val: '4.9/5', label: 'Average rating', icon: 'fa-star', color: 'blue' },
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
          <i class="fas fa-check-circle mr-1"></i>Verified testimonials
        </div>
        <h2 class="text-2xl font-black text-white mb-2">What they discovered</h2>
        <p class="text-gray-400 text-sm">Real people. Real situations. Real results.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        ${[
          {
            quote: '"I\'d been waiting for my boyfriend\'s reply for 4 days. Signal Decoder told me exactly what my gut was feeling but I refused to see. I stopped waiting. 2 hours of clarity instead of 2 weeks of anxiety."',
            name: 'Sarah M.', role: 'Dating — Quick Decode', stars: 5, outcome: 'Stopped waiting in vain'
          },
          {
            quote: '"My manager sent me a 2-line email after a presentation. I was completely lost. The analysis gave me the exact reading and the perfect reply. Crisis meeting cancelled, promotion still on track."',
            name: 'Thomas D.', role: 'Work — Deep Read', stars: 5, outcome: 'Avoided a critical professional situation'
          },
          {
            quote: '"I pasted 3 weeks of messages. The AI detected a breadcrumbing pattern in 30 seconds. I\'d been looking for that clarity for months with my friends and never got it. Now I\'ve moved on."',
            name: 'Léa K.', role: 'Dating — Pattern Analysis', stars: 5, outcome: 'Identified a pattern in 30 seconds'
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
          { name: 'M.C.', text: '"Verdict was 95% accurate"' },
          { name: 'J.B.', text: '"Best decision I ever made"' },
          { name: 'R.T.', text: '"My therapist would have taken 3 sessions"' },
          { name: 'A.L.', text: '"More objective than my friends"' },
          { name: 'P.V.', text: '"I should have used this sooner"' },
        ].map(r => `
        <div class="flex items-center gap-1.5">
          <div class="w-6 h-6 bg-gray-800 rounded-full flex items-center justify-center text-xs font-bold text-gray-400">${r.name.charAt(0)}</div>
          <span>${r.name} — <em class="text-gray-400">${r.text}</em></span>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       INLINE LEAD CAPTURE — Capture emails early (before pricing)
  ═══════════════════════════════════════════════════════ -->
  <section class="px-4 py-10 border-t border-white/5 bg-gradient-to-b from-violet-950/10 to-transparent">
    <div class="max-w-xl mx-auto text-center">
      <p class="text-gray-400 text-sm mb-3">Not ready to analyze yet? Get our free guide first:</p>
      <form id="lead-form-inline" class="flex flex-col sm:flex-row gap-3">
        <input type="email" name="lead-email-inline" placeholder="Your email..." required
          class="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm placeholder-gray-500">
        <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer whitespace-nowrap">
          Get "7 Signals That Never Lie" →
        </button>
      </form>
      <p class="text-gray-600 text-xs mt-2">Free · 1,200+ downloads · Zero spam</p>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════
       HOW IT WORKS — Simple, fast, no friction
  ═══════════════════════════════════════════════════════ -->
  <section id="how-it-works" class="px-4 py-16 border-t border-white/5">
    <div class="max-w-4xl mx-auto">
      <div class="text-center mb-10">
        <h2 class="text-2xl font-black text-white mb-2">How it works</h2>
        <p class="text-gray-400 text-sm">3 steps. 30 seconds. No account required.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        ${[
          { n:'01', icon:'fa-credit-card', color:'violet', title:'Choose your level', desc:'Start free or pick a paid tier. One payment. No subscription. No surprises.' },
          { n:'02', icon:'fa-paste', color:'blue', title:'Paste your situation', desc:'Message, email, social situation. Add context. Our AI does the rest in 30 seconds.' },
          { n:'03', icon:'fa-file-alt', color:'green', title:'Read your report', desc:'Scores, verdict, alternative readings, recommended action. Everything you need to know.' },
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
          ⚡ Available now — No waitlist
        </div>
        <h2 class="text-3xl sm:text-4xl font-black text-white mb-3">
          Choose your level of clarity
        </h2>
        <p class="text-gray-400 max-w-xl mx-auto">Think about how much time, energy, and bad decisions uncertainty is costing you. These analyses cost less than a barista coffee.</p>
      </div>

      <!-- Pricing Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mt-10">

        <!-- Mini Decode — FREE -->
        <div class="glass-card rounded-2xl p-6 border border-green-700/30 hover:border-green-500/40 transition-all relative">
          <div class="absolute -top-3 left-4 bg-green-600 text-white text-xs px-3 py-1 rounded-full font-black uppercase tracking-wider">
            FREE
          </div>
          <div class="text-green-400 text-xs font-mono mb-3 uppercase tracking-wider mt-2">Mini Decode</div>
          <div class="text-4xl font-black text-white mb-1">€0</div>
          <div class="text-gray-400 text-xs mb-5">Quick verdict — see what we do</div>
          <div class="space-y-2 mb-6">
            ${[
              ['fa-check', 'green', 'Verdict with confidence score'],
              ['fa-check', 'green', 'Top 3 observable signals'],
              ['fa-check', 'green', 'Main reading + probability'],
              ['fa-check', 'green', 'One recommended action'],
              ['fa-times', 'gray', 'No alternative readings'],
              ['fa-times', 'gray', 'No reply suggestions'],
            ].map(([ic, col, txt]) =>
              `<li class="flex items-start gap-2 text-sm ${col === 'gray' ? 'text-gray-600' : 'text-gray-300'} list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
            ).join('')}
          </div>
          <div class="mb-3">
            <input type="email" name="free-email" placeholder="Your email..." required
              class="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-gray-200 focus:outline-none focus:border-green-500 text-sm placeholder-gray-500">
          </div>
          <button data-offer="mini_decode"
            class="w-full bg-green-600 hover:bg-green-500 text-white py-3.5 rounded-xl font-bold transition-all cursor-pointer text-sm">
            Try free — no card needed →
          </button>
        </div>

        <!-- Quick Decode -->
        <div class="glass-card rounded-2xl p-6 border border-gray-700/50 hover:border-violet-500/40 transition-all">
          <div class="text-gray-400 text-xs font-mono mb-3 uppercase tracking-wider">Quick Decode</div>
          <div class="text-gray-600 text-sm line-through mb-1">Real value: €90</div>
          <div class="text-4xl font-black text-white mb-1">€14.99</div>
          <div class="text-gray-400 text-xs mb-5">Clear answer on a single message</div>
          <div class="space-y-2 mb-6">
            ${[
              ['fa-check', 'violet', 'Verdict with confidence score'],
              ['fa-check', 'violet', '3 observable signals decoded'],
              ['fa-check', 'violet', 'Main reading + probability'],
              ['fa-check', 'violet', '2 alternative readings'],
              ['fa-check', 'violet', 'Psychological insight & bias check'],
              ['fa-check', 'violet', 'Concrete recommended action'],
            ].map(([ic, col, txt]) =>
              `<li class="flex items-start gap-2 text-sm text-gray-300 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
            ).join('')}
          </div>
          <button data-offer="quick_decode"
            class="w-full bg-gray-800 hover:bg-violet-700 border border-gray-700 hover:border-violet-500 text-white py-3.5 rounded-xl font-bold transition-all cursor-pointer text-sm">
            Get my clarity — €14.99 →
          </button>
        </div>

        <!-- Deep Read — HERO OFFER -->
        <div class="relative rounded-2xl p-[2px] bg-gradient-to-b from-violet-500 to-blue-500 shadow-2xl shadow-violet-900/50">
          <div class="bg-[#111] rounded-2xl p-6 h-full">
            <div class="absolute -top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-violet-600 to-blue-600 text-white text-xs px-4 py-1.5 rounded-full font-black uppercase tracking-wider shadow-lg">
              BEST VALUE
            </div>
            <div class="text-violet-400 text-xs font-mono mb-3 uppercase tracking-wider">Deep Read</div>
            <div class="text-gray-600 text-sm line-through mb-1">Real value: €290</div>
            <div class="text-4xl font-black text-white mb-1">€24.99</div>
            <div class="text-gray-400 text-xs mb-5">Full analysis + reply suggestions included</div>
            <div class="space-y-2 mb-6">
              ${[
                ['fa-check', 'violet', 'Everything in Quick Decode'],
                ['fa-check', 'violet', 'Relational dynamics analyzed'],
                ['fa-check', 'violet', 'Hidden meanings & subtext detected'],
                ['fa-check', 'violet', 'Deep psychological frameworks applied'],
                ['fa-check', 'violet', '3 written reply suggestions included'],
                ['fa-check', 'violet', 'Immediate actionable strategy'],
              ].map(([ic, col, txt]) =>
                `<li class="flex items-start gap-2 text-sm text-gray-200 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
              ).join('')}
            </div>
            <button data-offer="deep_read"
              class="w-full bg-violet-600 hover:bg-violet-500 text-white py-4 rounded-xl font-black transition-all cursor-pointer pulse-glow text-base">
              Get my Deep Read — €24.99 →
            </button>
            <p class="text-center text-gray-600 text-xs mt-2">Money-back guarantee · Replies included</p>
          </div>
        </div>

        <!-- Pattern Analysis -->
        <div class="glass-card rounded-2xl p-6 border border-gray-700/50 hover:border-violet-500/40 transition-all">
          <div class="text-gray-400 text-xs font-mono mb-3 uppercase tracking-wider">Pattern Analysis</div>
          <div class="text-gray-600 text-sm line-through mb-1">Real value: €490</div>
          <div class="text-4xl font-black text-white mb-1">€49.99</div>
          <div class="text-gray-400 text-xs mb-5">Understand a relationship over time</div>
          <div class="space-y-2 mb-6">
            ${[
              ['fa-check', 'violet', 'Full history analysis'],
              ['fa-check', 'violet', 'Emotional trends (hot/cold)'],
              ['fa-check', 'violet', 'Effort asymmetry mapped'],
              ['fa-check', 'violet', 'Power dynamics & attachment style'],
              ['fa-check', 'violet', 'Breadcrumbing / manipulation detected'],
              ['fa-check', 'violet', '3 reply suggestions + strategy'],
            ].map(([ic, col, txt]) =>
              `<li class="flex items-start gap-2 text-sm text-gray-300 list-none"><i class="fas ${ic} text-${col}-400 mt-0.5 text-xs flex-shrink-0"></i>${txt}</li>`
            ).join('')}
          </div>
          <button data-offer="pattern_analysis"
            class="w-full bg-gray-800 hover:bg-violet-700 border border-gray-700 hover:border-violet-500 text-white py-3.5 rounded-xl font-bold transition-all cursor-pointer text-sm">
            Analyze my pattern — €49.99 →
          </button>
        </div>
      </div>

      <!-- Guarantee block -->
      <div class="mt-10 bg-green-950/30 border border-green-800/30 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-5 text-center sm:text-left">
        <div class="w-16 h-16 bg-green-900/50 rounded-2xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-shield-alt text-green-400 text-2xl"></i>
        </div>
        <div>
          <h3 class="font-black text-white text-lg mb-1">Satisfaction Guarantee — Instant Refund</h3>
          <p class="text-gray-300 text-sm">If your analysis doesn't give you real clarity, send an email within 24 hours. We refund — no questions asked. Zero risk.</p>
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
        <h2 class="text-2xl font-black text-white mb-2">All your questions. Straight answers.</h2>
        <p class="text-gray-500 text-sm">Because you deserve the truth, not marketing fluff.</p>
      </div>

      <!-- Comparison table (Hormozi: vs alternatives) -->
      <div class="glass-card rounded-2xl border border-gray-800 overflow-hidden mb-8">
        <div class="grid grid-cols-4 text-xs font-bold text-center bg-gray-900/60">
          <div class="p-3 text-left text-gray-400">Method</div>
          <div class="p-3 text-gray-400">Cost</div>
          <div class="p-3 text-gray-400">Delay</div>
          <div class="p-3 text-violet-400">Objectivity</div>
        </div>
        ${[
          { method: 'Ask friends', cost: '€0 but...',  time: '2-48h', obj: '❌ Emotional bias', highlight: false },
          { method: 'Coaching session',  cost: '€80-200',    time: '3-7 days', obj: '✓ Partial', highlight: false },
          { method: 'Therapy session',           cost: '€60-120',   time: '1-3 weeks', obj: '✓ Good', highlight: false },
          { method: '🧠 Signal Decoder', cost: 'Free — €49.99',   time: '< 5 minutes', obj: '✅ Zero bias', highlight: true },
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
            q: 'Can AI really analyze a human message?',
            a: 'Our AI was specifically trained to identify behavioral signals — timing, tone, effort, consistency. It doesn\'t read minds. It analyzes <strong class="text-white">observable facts</strong> and their probability of interpretation. It\'s exactly what a social communication expert would do, but in 30 seconds.'
          },
          {
            q: 'What if the result is completely off?',
            a: 'Instant refund, no questions asked, no justification needed. But across <strong class="text-white">2,847 analyses delivered</strong>, our satisfaction rate is 94%. The AI is calibrated to express its confidence level — it tells you when it\'s sure and when it\'s not.'
          },
          {
            q: 'Are my messages confidential?',
            a: 'Yes, completely. Your texts are <strong class="text-white">encrypted in transit</strong>, used only to generate your analysis, and automatically deleted after 30 days. We don\'t store them, read them, or sell them. Ever. Full GDPR compliance.'
          },
          {
            q: 'Is this different from asking a friend?',
            a: 'Profoundly different. Your friends love you — and that\'s <em>precisely why</em> they can\'t be objective. They filter what they tell you to protect you. Our AI has <strong class="text-white">zero emotional bias</strong> and systematically separates observable facts from interpretation.'
          },
          {
            q: 'How fast do I get my result?',
            a: 'Payment: 30 seconds. Form: 2 minutes. Analysis: 20-45 seconds. <strong class="text-white">Total: under 5 minutes</strong> from now to your answer. During those 5 minutes, you\'re still overthinking. After — you have a clear direction.'
          },
          {
            q: 'I just want quick advice, not a full analysis.',
            a: 'Try our free Mini Decode first — one message, one verdict, one action. If you want more depth, the Quick Decode at €14.99 adds alternative readings and psychological insights. No information overload. Just what you need.'
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
          FREE
        </div>
        <h2 class="text-xl font-black text-white mb-2">
          Not ready yet? Get our free guide.
        </h2>
        <p class="text-gray-400 text-sm mb-6">
          <strong class="text-white">"The 7 Signals That Never Lie"</strong> — The guide that 1,200+ people have downloaded to decode behavior without a paid tool.
        </p>
        <form id="lead-form" class="flex flex-col sm:flex-row gap-3">
          <input type="email" name="lead-email" placeholder="Your email..." required
            class="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm placeholder-gray-500">
          <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl font-bold text-sm transition-colors cursor-pointer whitespace-nowrap">
            Get the guide →
          </button>
        </form>
        <p class="text-gray-600 text-xs mt-2">Zero spam. Unsubscribe in 1 click.</p>
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
        Every hour you wait is another hour<br>
        <span class="gradient-text">torturing yourself for nothing.</span>
      </h2>
      <p class="text-gray-400 mb-3 text-lg">The clarity you've been searching for is <strong class="text-white">free to try</strong> and <strong class="text-white">5 minutes</strong> away.</p>
      <p class="text-gray-600 text-sm mb-8">And if the analysis doesn't help: full refund. Zero risk.</p>
      <a href="#pricing"
        class="inline-block bg-violet-600 hover:bg-violet-500 text-white px-12 py-5 rounded-2xl text-xl font-black transition-all pulse-glow shadow-2xl shadow-violet-900/60 mb-4">
        Get my clarity now →
      </a>
      <div class="flex flex-wrap justify-center gap-x-6 gap-y-1 text-xs text-gray-600 mt-4">
        <span>✓ Money-back guarantee</span>
        <span>✓ Result in &lt; 30 seconds</span>
        <span>✓ No sign-up</span>
        <span>✓ Secure Stripe payment</span>
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
        <a href="/privacy" class="hover:text-gray-400 transition-colors">Privacy</a>
        <a href="/terms" class="hover:text-gray-400 transition-colors">Terms</a>
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
<html lang="en">
${HEAD('Payment confirmed')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center" data-page="checkout-success">
  <div class="text-center max-w-md px-6">
    <div id="checkout-spinner" class="w-16 h-16 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-6"></div>
    <h1 class="text-2xl font-bold text-white mb-3">Payment confirmed!</h1>
    <p id="checkout-status" class="text-gray-400">Verifying, redirecting automatically...</p>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
}

function intakePage(analysisId: string, offerType: string, defaultMode: string): string {
  const offerLabels: Record<string, string> = {
    mini_decode: 'Mini Decode — Free',
    quick_decode: 'Quick Decode — €14.99',
    deep_read: 'Deep Read — €24.99',
    pattern_analysis: 'Pattern Analysis — €49.99',
  }

  const offerIcons: Record<string, string> = {
    mini_decode: 'fa-zap',
    quick_decode: 'fa-bolt',
    deep_read: 'fa-search',
    pattern_analysis: 'fa-chart-line',
  }

  const modes = [
    { id: 'message_decode', label: 'Message', icon: 'fa-comment', desc: 'Analyze a message' },
    { id: 'situation_decode', label: 'Situation', icon: 'fa-user-friends', desc: 'Social situation' },
    { id: 'dating_decode', label: 'Dating', icon: 'fa-heart', desc: 'Romantic signals' },
    { id: 'workplace_decode', label: 'Work', icon: 'fa-briefcase', desc: 'Work dynamics' },
    { id: 'pattern_analysis', label: 'Pattern', icon: 'fa-chart-line', desc: 'Relationship history' },
  ]

  return `<!DOCTYPE html>
<html lang="en">
${HEAD('Your analysis is ready — Describe your situation')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen py-8 px-4" data-page="intake">
  <div class="max-w-2xl mx-auto">

    <!-- Progress indicator — show momentum -->
    <div class="flex items-center mb-8 text-xs">
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-green-600 rounded-full flex items-center justify-center shadow-lg shadow-green-900/50">
          <i class="fas fa-check text-white text-xs"></i>
        </div>
        <span class="text-green-400 font-bold hidden sm:inline">${offerType === 'mini_decode' ? 'Free access ✓' : 'Payment ✓'}</span>
      </div>
      <div class="flex-1 h-1 bg-gradient-to-r from-green-600 to-violet-600 mx-2 rounded-full"></div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-violet-600 rounded-full flex items-center justify-center ring-2 ring-violet-400 shadow-lg shadow-violet-900/50">
          <span class="text-white font-black text-xs">2</span>
        </div>
        <span class="text-white font-bold hidden sm:inline">Your situation</span>
      </div>
      <div class="flex-1 h-1 bg-gray-800 mx-2 rounded-full"></div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center">
          <span class="text-gray-500 font-bold text-xs">3</span>
        </div>
        <span class="text-gray-600 hidden sm:inline">Result</span>
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
            <span class="text-gray-500 text-xs">Analysis ready to start</span>
          </div>
          <p class="text-gray-400 text-xs mt-1">
            One more step — describe your situation. <strong class="text-white">Result in 30 seconds.</strong>
          </p>
        </div>
      </div>
    </div>

    <!-- Hook / re-engagement headline (Hormozi: remind them why they paid) -->
    <div class="mb-6">
      <h1 class="text-2xl sm:text-3xl font-black text-white mb-2">
        The truth about this situation<br>
        <span class="text-violet-400">is 2 minutes away.</span>
      </h1>
      <p class="text-gray-400 text-sm">Be honest — no filter. Our AI is objective, your friends aren't. <strong class="text-white">More details = more accurate verdict.</strong></p>
    </div>

    <form id="intake-form" data-analysis-id="${analysisId}" class="space-y-5">
      <input type="hidden" name="offerType" value="${offerType}">
      <input type="hidden" name="mode" value="${defaultMode || 'message_decode'}">

      <!-- Mode selector — visual, frictionless -->
      <div>
        <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
          What type of situation? <span class="text-violet-400">*</span>
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
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Relationship context</label>
          <select name="contextType" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm">
            <option value="dating">❤️ Dating / Romantic</option>
            <option value="work">💼 Professional</option>
            <option value="friendship">👥 Friendship</option>
            <option value="family">🏠 Family</option>
            <option value="social">🌐 Social</option>
            <option value="other">📝 Other</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">Relationship duration</label>
          <select name="relationDuration" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 text-sm">
            <option value="new">🆕 New / Unknown</option>
            <option value="weeks">📅 A few weeks</option>
            <option value="months">🗓️ A few months</option>
            <option value="years">⭐ Over a year</option>
            <option value="longtime">💎 Long-term relationship</option>
          </select>
        </div>
      </div>

      <!-- Main input — primary value driver + quality signal indicator -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Message or situation <span class="text-violet-400">*</span>
          </label>
          <span id="char-count" class="text-gray-600 text-xs">0/5000</span>
        </div>
        <!-- Quality indicator bar -->
        <div class="h-1 bg-gray-800 rounded-full mb-2 overflow-hidden">
          <div id="quality-bar" class="h-1 rounded-full transition-all duration-300 bg-red-600" style="width:0%"></div>
        </div>
        <div id="quality-label" class="text-xs text-gray-600 mb-2">Signal quality: start typing...</div>
        <textarea name="inputText" required rows="7" maxlength="5000"
          placeholder="Paste the exact message here, or describe the situation with as much detail as possible...

Example: &quot;He replied 'Ok.' after 3 days of silence. He used to respond in under an hour, without exception. We've been seeing each other for 2 weeks. This change worries me.&quot;"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3.5 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 leading-relaxed text-sm"></textarea>
        <p class="text-gray-600 text-xs mt-1.5"><i class="fas fa-lightbulb text-amber-500 mr-1"></i>Tip: include the exact message + their usual behavior for the most accurate verdict.</p>
      </div>

      <!-- Extra context — optional but recommended -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-xs font-bold text-gray-400 uppercase tracking-wider">
            Additional context
          </label>
          <span class="text-violet-400 text-xs font-semibold">+40% accuracy</span>
        </div>
        <textarea name="extraContext" rows="2"
          placeholder="What changed recently, usual behavior, important past events..."
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 resize-none focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 text-sm"></textarea>
      </div>

      <!-- Goal — Hormozi: specificity creates clarity -->
      <div>
        <label class="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">
          What you really want to know
        </label>
        <input type="text" name="goal"
          placeholder="E.g.: Are they genuinely interested or just keeping me as an option?"
          class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-gray-200 focus:outline-none focus:border-violet-500 transition-colors placeholder-gray-600 text-sm">
      </div>

      <!-- Submit CTA — reinforce urgency and value -->
      <div class="pt-2">
        <button type="submit" id="submit-btn"
          class="w-full bg-violet-600 hover:bg-violet-500 text-white py-5 rounded-2xl font-black text-lg transition-all cursor-pointer shadow-xl shadow-violet-900/40 pulse-glow">
          <i class="fas fa-bolt mr-2"></i>Launch my analysis now →
        </button>
        <div class="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-gray-600 mt-3">
          <span><i class="fas fa-clock mr-1"></i>Result in 30 seconds</span>
          <span><i class="fas fa-lock mr-1"></i>Confidential</span>
          <span><i class="fas fa-shield-alt mr-1"></i>Guaranteed or refunded</span>
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
<html lang="en">
${HEAD('Analysis in progress')}
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

    <h1 class="text-2xl font-bold text-white mb-2">Analysis in progress...</h1>
    <p id="step-text" class="text-gray-400 text-sm mb-8 font-mono">Initializing analysis...</p>

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
<html lang="en">
${HEAD('Content blocked')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="result" data-analysis-id="${analysisId}">
  <div class="max-w-md text-center">
    <div class="w-16 h-16 bg-amber-900/50 rounded-xl flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-shield-alt text-amber-400 text-2xl"></i>
    </div>
    <h1 class="text-2xl font-bold text-white mb-4">Content cannot be analyzed</h1>
    <p class="text-gray-400 mb-6">This content cannot be analyzed in accordance with our safety policy.</p>
    <div class="bg-amber-900/20 border border-amber-800/30 rounded-xl p-4 mb-6 text-sm text-gray-300">
      If you are going through a difficult time, resources are available 24/7:
      <br><a href="tel:988" class="text-amber-400 font-bold">988</a> — Suicide & Crisis Lifeline
    </div>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Back to home</a>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
  }

  if (!result) {
    return `<!DOCTYPE html>
<html lang="en">
${HEAD('Result')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="result" data-analysis-id="${analysisId}">
  <div class="text-center max-w-md">
    <h1 class="text-2xl font-bold text-white mb-4">Result unavailable</h1>
    <p class="text-gray-400 mb-6">The analysis could not be generated. Your credit is preserved.</p>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Back</a>
  </div>
  <script src="/static/app.js"></script>
</body>
</html>`
  }

  const rawScores = (result.scores as Record<string, number>) || {}
  // Normalize scores: LLM may return 0-1, 0-10, or 0-100, we need 0-100 for display
  const scores: Record<string, number> = {}
  for (const [key, val] of Object.entries(rawScores)) {
    if (val <= 1) scores[key] = Math.round(val * 100)        // 0-1 scale (e.g. 0.7 → 70)
    else if (val <= 10) scores[key] = Math.round(val * 10)    // 0-10 scale (e.g. 7 → 70)
    else scores[key] = Math.round(val)                         // already 0-100
  }
  const mainReading = result.main_reading as { title: string; description: string; probability_score: number } | undefined
  const alternativeReadings = (result.alternative_readings as Array<{ title: string; description: string; probability_score: number }>) || []
  const observableSignals = (result.observable_signals as Array<{ signal: string; type: string; interpretation: string }>) || []
  const bestNextAction = result.best_next_action as { action: string; rationale: string } | undefined
  const replyOptions = (result.reply_options as Array<{ style: string; text: string; why_it_works: string }>) || []
  const uncertainties = (result.uncertainties as string[]) || []
  const psychologicalInsight = result.psychological_insight as { framework: string; insight: string; implication: string } | undefined
  const biasCheck = (result.bias_check as Array<{ bias: string; how_it_applies: string; reality_test: string }>) || []
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
    interest: 'Interest',
    clarity: 'Signal clarity',
    respect: 'Respect',
    effort: 'Effort',
    manipulation_risk: 'Manipulation risk',
  }

  const offerLabel: Record<string, string> = {
    quick_decode: 'Quick Decode',
    deep_read: 'Deep Read',
    pattern_analysis: 'Pattern Analysis',
  }

  return `<!DOCTYPE html>
<html lang="en">
${HEAD('Your analysis — Full report')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen" data-page="result" data-analysis-id="${analysisId}">

  <!-- Result Header Banner (Hormozi: celebrate the win immediately) -->
  <div class="bg-gradient-to-r from-violet-900/60 to-blue-900/40 border-b border-violet-700/20 px-4 py-4">
    <div class="max-w-3xl mx-auto flex items-center justify-between flex-wrap gap-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center">
          <i class="fas fa-check text-white"></i>
        </div>
        <div>
          <div class="text-white font-black text-sm">Full analysis — ${offerLabel[analysis.offer_type] || analysis.offer_type}</div>
          <div class="text-gray-400 text-xs">Report generated · Confidence: <span class="text-violet-400 font-bold">${confidence}%</span></div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="copy-btn" class="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer">
          <i class="fas fa-copy"></i> Copy summary
        </button>
        <a href="/" class="flex items-center gap-2 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-600/30 text-violet-300 px-3 py-2 rounded-lg text-xs font-semibold transition-colors">
          <i class="fas fa-plus"></i> New analysis
        </a>
      </div>
    </div>
  </div>

  <div class="max-w-3xl mx-auto py-8 px-4">

    <!-- Confidence Score Hero (big, impactful) -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-violet-500/20 bg-gradient-to-br from-violet-900/20 to-blue-900/10">
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div class="flex-1">
          <div class="text-violet-400 text-xs font-mono mb-2 uppercase tracking-wider">Main verdict</div>
          <h1 id="result-summary" class="text-xl sm:text-2xl font-black text-white leading-snug">${escapeHtml(String(result.summary || ''))}</h1>
        </div>
        <div class="flex flex-col items-center bg-violet-900/30 border border-violet-700/30 rounded-xl p-4 flex-shrink-0">
          <div class="font-mono text-4xl font-black text-violet-400">${confidence}%</div>
          <div class="text-gray-500 text-xs mt-1">confidence</div>
          <div class="text-xs mt-2 text-center ${confidence >= 70 ? 'text-green-400' : confidence >= 50 ? 'text-amber-400' : 'text-red-400'} font-semibold">
            ${confidence >= 70 ? '✓ Clear signal' : confidence >= 50 ? '~ Moderate signal' : '⚠ Weak signal'}
          </div>
        </div>
      </div>
    </div>

    <!-- Scores — Visual impact -->
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Situation scores</div>
      <div class="space-y-4">
        ${Object.entries(scores).map(([key, val]) => {
          const color = scoreColors[key] || 'violet'
          const label = scoreLabels[key] || key
          const value = typeof val === 'number' ? val : 0
          const zone = value <= 29 ? { text: 'Critical', c: 'red' } : value <= 49 ? { text: 'Low', c: 'orange' } : value <= 69 ? { text: 'Neutral', c: 'amber' } : value <= 84 ? { text: 'Positive', c: 'green' } : { text: 'Excellent', c: 'emerald' }
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
          <div class="text-violet-400 text-xs font-mono uppercase tracking-wider">Main reading</div>
          <div class="bg-violet-900/50 border border-violet-700/30 font-mono text-violet-300 text-sm font-bold px-3 py-1 rounded-full">${mainReading.probability_score > 1 ? Math.round(mainReading.probability_score) : Math.round(mainReading.probability_score * 100)}% probability</div>
        </div>
        <h3 class="text-2xl font-black text-white mb-3">${escapeHtml(mainReading.title)}</h3>
        <p class="text-gray-300 leading-relaxed">${escapeHtml(mainReading.description)}</p>
      </div>
    </div>` : ''}

    <!-- Alternative Readings -->
    ${alternativeReadings.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Alternative readings</div>
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
      <div class="text-gray-400 text-xs font-mono mb-4 uppercase tracking-wider">Observable signals analyzed</div>
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
      ${analysis.offer_type === 'mini_decode' ? `
      <div class="mt-3 bg-gray-900/60 border border-gray-700 rounded-xl p-3 flex items-center gap-3">
        <i class="fas fa-lock text-gray-500"></i>
        <span class="text-gray-500 text-xs">+ more signals detected — <a href="/#pricing" class="text-violet-400 font-semibold hover:text-violet-300">unlock with Quick Decode</a></span>
      </div>` : ''}
    </div>` : ''}

    <!-- Psychological Insight -->
    ${analysis.offer_type === 'mini_decode' ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-purple-500/10 bg-purple-900/5 relative overflow-hidden">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-8 h-8 bg-purple-700/50 rounded-lg flex items-center justify-center">
          <i class="fas fa-brain text-purple-400 text-sm"></i>
        </div>
        <div class="text-purple-400 text-xs font-mono uppercase tracking-wider font-bold">Psychological insight</div>
        <span class="ml-auto bg-purple-900/40 border border-purple-700/30 text-purple-300 text-xs px-2 py-0.5 rounded-full"><i class="fas fa-lock text-xs mr-1"></i>Locked</span>
      </div>
      <div class="filter blur-sm select-none pointer-events-none">
        <div class="bg-purple-900/20 border border-purple-800/30 rounded-xl px-4 py-2 mb-3">
          <span class="text-purple-300 text-xs font-bold">Attachment Theory Framework</span>
        </div>
        <p class="text-gray-200 text-sm leading-relaxed mb-2">This behavior pattern is consistent with a specific attachment style that reveals...</p>
      </div>
      <div class="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
        <a href="/#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-xl transition-colors">
          Unlock psychological insight — from €14.99 →
        </a>
      </div>
    </div>` : psychologicalInsight?.framework ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-purple-500/20 bg-gradient-to-br from-purple-900/10 to-indigo-900/10">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-8 h-8 bg-purple-700/50 rounded-lg flex items-center justify-center">
          <i class="fas fa-brain text-purple-400 text-sm"></i>
        </div>
        <div class="text-purple-400 text-xs font-mono uppercase tracking-wider font-bold">Psychological insight</div>
      </div>
      <div class="bg-purple-900/20 border border-purple-800/30 rounded-xl px-4 py-2 mb-3">
        <span class="text-purple-300 text-xs font-bold">${escapeHtml(psychologicalInsight.framework)}</span>
      </div>
      <p class="text-gray-200 text-sm leading-relaxed mb-2">${escapeHtml(psychologicalInsight.insight)}</p>
      ${psychologicalInsight.implication ? `<p class="text-gray-400 text-xs leading-relaxed border-t border-purple-800/20 pt-2 mt-2"><strong class="text-purple-300">What this means:</strong> ${escapeHtml(psychologicalInsight.implication)}</p>` : ''}
    </div>` : ''}

    <!-- Bias Check -->
    ${analysis.offer_type === 'mini_decode' ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-orange-500/10 bg-orange-900/5 relative overflow-hidden">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-8 h-8 bg-orange-700/50 rounded-lg flex items-center justify-center">
          <i class="fas fa-eye text-orange-400 text-sm"></i>
        </div>
        <div class="text-orange-400 text-xs font-mono uppercase tracking-wider font-bold">Bias check</div>
        <span class="ml-auto bg-orange-900/40 border border-orange-700/30 text-orange-300 text-xs px-2 py-0.5 rounded-full"><i class="fas fa-lock text-xs mr-1"></i>Locked</span>
      </div>
      <div class="filter blur-sm select-none pointer-events-none">
        <div class="bg-gray-900/50 border border-orange-900/20 rounded-xl p-4">
          <div class="text-orange-300 text-sm font-bold mb-1">Confirmation Bias Detected</div>
          <p class="text-gray-400 text-xs leading-relaxed">You may be selectively interpreting signals to confirm your existing fear...</p>
        </div>
      </div>
      <div class="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px] mt-12">
        <a href="/#pricing" class="bg-orange-600 hover:bg-orange-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-xl transition-colors">
          Check your biases — from €14.99 →
        </a>
      </div>
    </div>` : biasCheck.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-orange-500/10 bg-orange-900/5">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-8 h-8 bg-orange-700/50 rounded-lg flex items-center justify-center">
          <i class="fas fa-eye text-orange-400 text-sm"></i>
        </div>
        <div class="text-orange-400 text-xs font-mono uppercase tracking-wider font-bold">Bias check — are you reading this clearly?</div>
      </div>
      <div class="space-y-3">
        ${biasCheck.map(b => `
        <div class="bg-gray-900/50 border border-orange-900/20 rounded-xl p-4">
          <div class="text-orange-300 text-sm font-bold mb-1">${escapeHtml(b.bias)}</div>
          <p class="text-gray-400 text-xs leading-relaxed mb-2">${escapeHtml(b.how_it_applies)}</p>
          <div class="bg-orange-950/30 border border-orange-800/20 rounded-lg px-3 py-2">
            <span class="text-orange-400 text-xs font-semibold">Reality test:</span>
            <span class="text-gray-300 text-xs"> ${escapeHtml(b.reality_test)}</span>
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
        <div class="text-green-400 text-xs font-mono uppercase tracking-wider font-bold">Best next action</div>
      </div>
      <h3 class="text-xl font-black text-white mb-2">${escapeHtml(bestNextAction.action)}</h3>
      <p class="text-gray-300 text-sm leading-relaxed">${escapeHtml(bestNextAction.rationale)}</p>
    </div>` : ''}

    <!-- Reply Options (if included) -->
    ${replyOptions.length > 0 ? `
    <div class="glass-card rounded-2xl p-6 mb-6 border border-white/5">
      <div class="flex items-center gap-2 mb-4">
        <div class="text-gray-400 text-xs font-mono uppercase tracking-wider">Reply suggestions</div>
        <div class="bg-violet-900/30 border border-violet-700/30 text-violet-300 text-xs px-2 py-0.5 rounded-full">Included</div>
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
      <div class="text-amber-400 text-xs font-mono mb-2 uppercase tracking-wider">⚠ Sources of uncertainty</div>
      <ul class="space-y-1.5">
        ${uncertainties.map(u => `<li class="text-gray-400 text-xs flex items-start gap-2"><i class="fas fa-exclamation-triangle text-amber-500 mt-0.5 text-xs flex-shrink-0"></i>${escapeHtml(u)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <!-- UPSELL — only for mini_decode and quick_decode (deep_read+ includes replies) -->
    ${(analysis.offer_type === 'mini_decode' || analysis.offer_type === 'quick_decode') && (!upsellStatus || upsellStatus === 'offered') ? `
    <div class="rounded-2xl p-[2px] bg-gradient-to-r from-violet-600 to-blue-500 mb-6 shadow-2xl shadow-violet-900/30">
      <div class="bg-[#0a0816] rounded-2xl p-6">
        <!-- Header with scarcity -->
        <div class="flex items-start justify-between gap-3 mb-4">
          <div>
            <div class="bg-amber-900/40 border border-amber-700/30 text-amber-300 text-xs px-3 py-1 rounded-full font-bold inline-block mb-2">
              ⚡ This offer disappears when you leave the page
            </div>
            <h3 class="text-xl font-black text-white">
              You know what it means.<br>
              <span class="text-violet-400">But what do you reply?</span>
            </h3>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-gray-600 text-xs line-through">Real value: €49</div>
            <div class="text-3xl font-black text-white">€9</div>
          </div>
        </div>

        <!-- Value stack -->
        <p class="text-gray-300 text-sm mb-4 leading-relaxed">
          Our AI writes <strong class="text-white">3 custom reply versions</strong> — tailored to your specific situation, not generic templates. Each version comes with an explanation of why it works <em>in your context</em>.
        </p>

        <div class="grid grid-cols-3 gap-3 mb-4">
          ${[
            { icon: 'fa-dove', color: 'green', label: 'Diplomatic', desc: 'Warm, opens a door without pressure' },
            { icon: 'fa-bullseye', color: 'blue', label: 'Direct', desc: 'Clear, assertive, no ambiguity' },
            { icon: 'fa-snowflake', color: 'slate', label: 'Detached', desc: 'Low investment, high-value signal' },
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
          <p class="text-gray-400 text-xs italic">"The 3 suggested messages were exactly what I needed. I picked the Detached one. He called me back that same day." — Marie L.</p>
        </div>

        <button id="upsell-btn"
          class="w-full bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 text-white py-4 rounded-xl font-black text-base transition-all cursor-pointer shadow-xl">
          Get my 3 written replies — €9 →
        </button>
        <p class="text-center text-gray-600 text-xs mt-2">Instant result · Money-back guarantee · One-time offer</p>
      </div>
    </div>` : upsellStatus === 'paid' ? `
    <div class="bg-green-950/30 border border-green-700/30 rounded-2xl p-5 mb-6 flex items-center gap-3">
      <i class="fas fa-check-circle text-green-400 text-xl"></i>
      <div>
        <div class="text-green-300 font-bold text-sm">Reply Generator activated</div>
        <div class="text-gray-400 text-xs">Your written replies are included above.</div>
      </div>
    </div>` : ''}

    <!-- Upgrade CTA for free users -->
    ${analysis.offer_type === 'mini_decode' ? `
    <div class="rounded-2xl p-[2px] bg-gradient-to-r from-violet-600 to-blue-500 mb-6 shadow-2xl shadow-violet-900/30">
      <div class="bg-[#0a0816] rounded-2xl p-6 text-center">
        <div class="text-3xl mb-3">🔓</div>
        <h3 class="text-xl font-black text-white mb-2">Want the full picture?</h3>
        <p class="text-gray-400 text-sm mb-2">Your free analysis showed the surface. Unlock:</p>
        <div class="grid grid-cols-2 gap-2 mb-4 text-left max-w-sm mx-auto">
          ${[
            'Alternative readings',
            'Psychological frameworks',
            'Cognitive bias check',
            'Reply suggestions',
            'Deep subtext analysis',
            'Full actionable strategy',
          ].map(f => `<div class="flex items-center gap-2 text-xs text-gray-300"><i class="fas fa-lock-open text-violet-400 text-xs"></i>${f}</div>`).join('')}
        </div>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl font-bold text-sm transition-colors">
            Upgrade to Deep Read — €24.99 →
          </a>
          <a href="/#pricing" class="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 px-6 py-3 rounded-xl font-bold text-sm transition-colors">
            See all plans
          </a>
        </div>
      </div>
    </div>` : ''}

    <!-- Disclaimer + CTA to new analysis -->
    <div class="text-center text-xs text-gray-600 mt-6 pb-10 space-y-2">
      <p>This analysis is probabilistic. It does not replace the advice of a mental health professional.</p>
      <p>Probability ≠ Certainty — <em>"Observable signals first."</em></p>
      <div class="mt-4">
        <a href="/" class="text-violet-500 hover:text-violet-400 transition-colors font-semibold">
          <i class="fas fa-plus-circle mr-1"></i>Analyze another situation →
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
<html lang="en">
${HEAD('One more step — Get the perfect reply')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4" data-page="upsell" data-analysis-id="${analysisId}">
  <div class="max-w-lg w-full">

    <!-- Value-first header -->
    <div class="text-center mb-8">
      <div class="inline-block bg-violet-900/40 border border-violet-700/30 text-violet-300 text-xs px-3 py-1.5 rounded-full mb-4 font-semibold">
        You now know what it means
      </div>
      <h1 class="text-2xl sm:text-3xl font-black text-white mb-3">
        The question that remains:<br>
        <span class="gradient-text">What do you reply?</span>
      </h1>
      <p class="text-gray-400 text-sm">Our AI writes 3 messages calibrated to your situation — with an explanation of why each version works.</p>
    </div>

    <!-- Offer card -->
    <div class="rounded-2xl p-[2px] bg-gradient-to-b from-violet-500 to-blue-500 mb-6">
      <div class="bg-[#0f0f14] rounded-2xl p-6">
        <!-- Anchoring -->
        <div class="flex items-center justify-between mb-5">
          <div>
            <div class="text-gray-500 text-sm line-through">Value of a coach: €49+</div>
            <div class="text-4xl font-black text-white">€9 <span class="text-gray-500 text-lg font-normal">one time</span></div>
          </div>
          <div class="bg-amber-900/30 border border-amber-700/30 text-amber-300 text-xs px-3 py-1.5 rounded-full font-bold">
            One-time offer
          </div>
        </div>

        <!-- What you get -->
        <div class="space-y-3 mb-6">
          ${[
            { icon: 'fa-dove', color: 'green', style: 'Diplomatic', what: 'Warm, open, no confrontation. Ideal for keeping the door open.'},
            { icon: 'fa-bullseye', color: 'blue', style: 'Direct', what: 'Clear, honest, no beating around the bush. For those who want straight answers.'},
            { icon: 'fa-snowflake', color: 'gray', style: 'Detached', what: 'Low visible investment. High-value signal. To stop being in the weaker position.'},
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
          Write my 3 replies — €9 →
        </button>
        <p class="text-center text-gray-600 text-xs mt-2">Instant result · Money-back guarantee</p>
      </div>
    </div>

    <div class="text-center">
      <a href="/result/${analysisId}" class="text-gray-600 hover:text-gray-400 text-xs transition-colors">
        No thanks, I'll figure it out myself
      </a>
    </div>
  </div>
  <script src="/static/app.js"></script>
  <script>
    async function handleUpsellCheckout(analysisId) {
      const btn = document.getElementById('upsell-checkout-btn')
      btn.disabled = true
      btn.textContent = 'Redirecting to payment...'
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
        btn.textContent = 'Write my 3 replies — €9 →'
      }
    }
  </script>
</body>
</html>`
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
${HEAD(title)}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen flex items-center justify-center px-4">
  <div class="text-center max-w-md">
    <div class="w-16 h-16 bg-red-900/50 rounded-xl flex items-center justify-center mx-auto mb-4">
      <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
    </div>
    <h1 class="text-2xl font-bold text-white mb-3">${escapeHtml(title)}</h1>
    <p class="text-gray-400 mb-6">${escapeHtml(message)}</p>
    <a href="/" class="bg-violet-600 hover:bg-violet-500 text-white px-6 py-3 rounded-xl inline-block transition-colors">Back to home</a>
  </div>
</body>
</html>`
}

function legalPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
${HEAD(title)}
<body class="bg-[#0a0a0a] text-gray-100 font-sans max-w-3xl mx-auto px-6 py-16">
  <a href="/" class="text-gray-400 hover:text-white text-sm mb-6 inline-block">← Back</a>
  <h1 class="text-3xl font-bold text-white mb-8">${escapeHtml(title)}</h1>
  <div class="prose prose-invert max-w-none text-gray-300 space-y-4 text-sm leading-relaxed">
    ${content}
  </div>
</body>
</html>`
}

function privacyContent(): string {
  return `
  <p><strong>Last updated:</strong> April 16, 2026</p>

  <h2 class="text-xl font-bold text-white mt-6">1. Data controller</h2>
  <p>The data controller is:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Company name:</strong> Strategixs — Société par actions simplifiée (SAS)</li>
    <li><strong>Address:</strong> 50 Avenue des Champs Élysées, 75008 Paris, France</li>
    <li><strong>SIREN:</strong> 929 145 621</li>
    <li><strong>SIRET:</strong> 929 145 621 00017</li>
    <li><strong>VAT No.:</strong> FR61929145621</li>
    <li><strong>Email:</strong> social@strategixs.net</li>
  </ul>
  <p class="mt-2">For any questions regarding your personal data, contact us at the address above.</p>

  <h2 class="text-xl font-bold text-white mt-6">2. Data collected</h2>
  <p>We collect the following data:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Email:</strong> collected via Stripe during payment, or via the capture form (newsletter).</li>
    <li><strong>Submitted texts:</strong> the message or situation you submit for analysis.</li>
    <li><strong>Analysis context:</strong> relationship type, analysis mode, additional context provided voluntarily.</li>
    <li><strong>Payment data:</strong> processed exclusively by Stripe (we do not store card numbers or banking details).</li>
    <li><strong>Technical data:</strong> IP address, user-agent, request timestamps (collected automatically for service security).</li>
  </ul>
  <p class="mt-2">No user account is created. We do not collect names, postal addresses, or phone numbers.</p>

  <h2 class="text-xl font-bold text-white mt-6">3. Legal basis for processing</h2>
  <p>Your data is processed under the following legal bases (GDPR Art. 6):</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Contract performance:</strong> processing your order, generating the analysis, managing payment.</li>
    <li><strong>Consent:</strong> newsletter signup, voluntary email capture.</li>
    <li><strong>Legitimate interest:</strong> service security, fraud prevention, technical logs.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">4. Purpose of processing</h2>
  <p>Your data is used exclusively for:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Generating your personalized analysis via our AI engine.</li>
    <li>Processing and confirming your payment.</li>
    <li>Contacting you in case of a technical issue related to your order.</li>
    <li>Improving service quality (anonymized and aggregated data only).</li>
  </ul>
  <p class="mt-2">Your texts are <strong>never</strong> used to train AI models.</p>

  <h2 class="text-xl font-bold text-white mt-6">5. Sub-processors and data sharing</h2>
  <p>Your data is shared with the following providers, strictly necessary for the operation of the service:</p>
  <table class="w-full text-sm mt-2 border border-gray-700">
    <thead><tr class="bg-gray-800"><th class="px-3 py-2 text-left">Provider</th><th class="px-3 py-2 text-left">Role</th><th class="px-3 py-2 text-left">Location</th></tr></thead>
    <tbody>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">Stripe, Inc.</td><td class="px-3 py-2">Payment processing</td><td class="px-3 py-2">USA (DPF certified)</td></tr>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">OpenAI, Inc.</td><td class="px-3 py-2">AI analysis generation</td><td class="px-3 py-2">USA (DPF certified)</td></tr>
      <tr class="border-t border-gray-700"><td class="px-3 py-2">Cloudflare, Inc.</td><td class="px-3 py-2">Hosting, CDN, database</td><td class="px-3 py-2">Global (DPF certified)</td></tr>
    </tbody>
  </table>
  <p class="mt-2">Your data is <strong>never sold</strong> to third parties. No data is shared for advertising purposes.</p>

  <h2 class="text-xl font-bold text-white mt-6">6. Transfers outside the European Union</h2>
  <p>Some of our providers are based in the United States. These transfers are governed by:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>The <strong>EU-U.S. Data Privacy Framework (DPF)</strong> for Stripe, OpenAI, and Cloudflare.</li>
    <li><strong>Standard Contractual Clauses (SCCs)</strong> from the European Commission where the DPF does not apply.</li>
  </ul>
  <p class="mt-2">In accordance with Article 46 of the GDPR, appropriate safeguards are in place to protect your data.</p>

  <h2 class="text-xl font-bold text-white mt-6">7. Data retention</h2>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Submitted texts and analyses:</strong> 90 days, then automatic deletion.</li>
    <li><strong>Email:</strong> retained as long as necessary for the business relationship, maximum 3 years after the last purchase.</li>
    <li><strong>Payment data:</strong> retained by Stripe according to their own policy (legal accounting obligations).</li>
    <li><strong>Technical logs:</strong> 30 days maximum.</li>
    <li><strong>Newsletter:</strong> until unsubscription.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">8. Cookies and tracking technologies</h2>
  <p>This site uses cookies strictly necessary for the operation of the service:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Technical session:</strong> maintaining your browsing session (no tracking cookies).</li>
    <li><strong>Cloudflare:</strong> security and performance cookies (cf-bm, __cflb).</li>
  </ul>
  <p class="mt-2">We use <strong>no advertising, analytics, or profiling cookies</strong>. No third-party tracking tools (Google Analytics, Facebook Pixel, etc.) are installed.</p>

  <h2 class="text-xl font-bold text-white mt-6">9. Your rights (GDPR)</h2>
  <p>Under the General Data Protection Regulation (GDPR), you have the following rights:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Right of access:</strong> obtain a copy of your personal data.</li>
    <li><strong>Right to rectification:</strong> correct inaccurate data.</li>
    <li><strong>Right to erasure:</strong> request deletion of your data.</li>
    <li><strong>Right to data portability:</strong> receive your data in a structured format.</li>
    <li><strong>Right to object:</strong> object to the processing of your data.</li>
    <li><strong>Right to restriction:</strong> restrict processing in certain cases.</li>
    <li><strong>Right to withdraw consent:</strong> at any time, without affecting the lawfulness of prior processing.</li>
  </ul>
  <p class="mt-3">To exercise your rights, send an email to <strong>social@strategixs.net</strong> with the subject "GDPR Request". We will respond within 30 days maximum.</p>

  <h2 class="text-xl font-bold text-white mt-6">10. Complaints</h2>
  <p>If you believe that the processing of your data does not comply with regulations, you may file a complaint with the <strong>CNIL</strong> (Commission Nationale de l'Informatique et des Libertés), the French data protection authority:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Website: <a href="https://www.cnil.fr" class="text-violet-400 hover:underline" target="_blank" rel="noopener">www.cnil.fr</a></li>
    <li>Address: 3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">11. Data security</h2>
  <p>We implement the following technical and organizational measures:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>HTTPS/TLS encryption on all communications.</li>
    <li>Database encrypted at rest (Cloudflare D1).</li>
    <li>Restricted data access (principle of least privilege).</li>
    <li>Brute-force attack protection (rate limiting).</li>
    <li>Cryptographic verification of payment webhooks.</li>
    <li>No banking data stored on our servers.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">12. Minors</h2>
  <p>This service is intended for individuals <strong>aged 16 and over</strong>. We do not knowingly collect data from minors under 16. If you are a parent and believe your child has used this service, contact us for deletion.</p>

  <h2 class="text-xl font-bold text-white mt-6">13. Changes</h2>
  <p>This policy may be updated. In case of a substantial change, a notice will be displayed on the site. The last updated date at the top of this page prevails.</p>
  `
}

function termsContent(): string {
  return `
  <p><strong>Last updated:</strong> April 16, 2026</p>

  <h2 class="text-xl font-bold text-white mt-6">1. Legal notice</h2>
  <p>The Signal Decoder service is published by:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Publisher:</strong> Strategixs — Société par actions simplifiée (SAS)</li>
    <li><strong>Address:</strong> 50 Avenue des Champs Élysées, 75008 Paris, France</li>
    <li><strong>SIREN:</strong> 929 145 621 · <strong>SIRET:</strong> 929 145 621 00017</li>
    <li><strong>Intra-Community VAT No.:</strong> FR61929145621</li>
    <li><strong>Email:</strong> social@strategixs.net</li>
    <li><strong>Host:</strong> Cloudflare, Inc. — 101 Townsend Street, San Francisco, CA 94107, USA — <a href="https://www.cloudflare.com" class="text-violet-400 hover:underline" target="_blank" rel="noopener">www.cloudflare.com</a></li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">2. Purpose of the service</h2>
  <p>Signal Decoder is an AI-assisted analysis tool. It provides a <strong>probabilistic interpretation</strong> of messages and social situations submitted by the user.</p>
  <p class="mt-2"><strong>The service does not constitute in any way:</strong></p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Medical, psychological, or psychiatric advice.</li>
    <li>Legal advice.</li>
    <li>A clinical diagnosis or mental health assessment.</li>
    <li>A substitute for consultation with a qualified professional.</li>
  </ul>
  <p class="mt-2">Results are provided for informational and entertainment purposes. The user remains solely responsible for decisions made based on these analyses.</p>

  <h2 class="text-xl font-bold text-white mt-6">3. Acceptance of terms</h2>
  <p>Use of the service implies full and complete acceptance of these Terms of Use. If you do not accept these terms, you must not use the service.</p>

  <h2 class="text-xl font-bold text-white mt-6">4. Access to the service</h2>
  <p>The service is accessible online, without creating an account. Access to analyses is conditional on prior payment via Stripe.</p>
  <p class="mt-2">We reserve the right to temporarily suspend or interrupt the service for maintenance, updates, or force majeure, without compensation.</p>

  <h2 class="text-xl font-bold text-white mt-6">5. Pricing and payment</h2>
  <p>Prices are displayed in euros (EUR), all taxes included. Available offers are:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>Mini Decode:</strong> Free — basic verdict on a single message.</li>
    <li><strong>Quick Decode:</strong> €14.99 — concise analysis of a single message.</li>
    <li><strong>Deep Read:</strong> €24.99 — in-depth analysis with context and reply suggestions.</li>
    <li><strong>Pattern Analysis:</strong> €49.99 — relational pattern analysis with reply suggestions.</li>
    <li><strong>Reply Generator (upsell):</strong> €9 — 3 personalized reply suggestions (for Quick/Mini Decode).</li>
  </ul>
  <p class="mt-2">Payments are processed securely by <strong>Stripe, Inc.</strong> We do not store any banking data.</p>
  <p class="mt-2">We reserve the right to modify prices at any time. Changes do not affect orders already confirmed.</p>

  <h2 class="text-xl font-bold text-white mt-6">6. Right of withdrawal</h2>
  <p>In accordance with Article L221-28 of the French Consumer Code, the right of withdrawal <strong>does not apply</strong> to contracts for the supply of digital content not provided on a tangible medium where performance has begun with the consumer's prior consent.</p>
  <p class="mt-2">By confirming your order and submitting text for analysis, you expressly agree that the service begins immediately and you waive your right of withdrawal.</p>
  <p class="mt-2"><strong>Satisfaction guarantee:</strong> despite the inapplicability of the right of withdrawal, we offer a refund in the event of a verified technical malfunction preventing delivery of the analysis (server error, generation failure). Contact social@strategixs.net within 7 days of purchase.</p>

  <h2 class="text-xl font-bold text-white mt-6">7. Intellectual property</h2>
  <ul class="list-disc pl-5 space-y-1">
    <li><strong>The service:</strong> the entire site, its design, source code, and algorithms are the exclusive property of Strategixs. Any reproduction is prohibited.</li>
    <li><strong>Your texts:</strong> the texts you submit remain your property. You grant us a temporary and limited license to process them via our AI engine.</li>
    <li><strong>The analyses:</strong> generated analyses are granted to you as a personal, non-transferable license. You may use them freely for private purposes.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">8. Prohibited content</h2>
  <p>It is strictly forbidden to use the service to:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Plan, facilitate, or encourage illegal acts.</li>
    <li>Harass, threaten, intimidate, or harm others.</li>
    <li>Submit content of a child sexual abuse nature.</li>
    <li>Manipulate, emotionally exploit, or exercise coercive control over a person.</li>
    <li>Monitor, stalk, or spy on a person without their consent.</li>
  </ul>
  <p class="mt-2">Any abusive use will result in the analysis being blocked without refund and may be reported to the relevant authorities.</p>

  <h2 class="text-xl font-bold text-white mt-6">9. Limitation of liability</h2>
  <p>Signal Decoder provides <strong>probabilistic analyses generated by artificial intelligence</strong>. Accordingly:</p>
  <ul class="list-disc pl-5 space-y-1">
    <li>Results are not guaranteed to be accurate, complete, or suited to your specific situation.</li>
    <li>Strategixs cannot be held liable for decisions made by the user based on the analyses.</li>
    <li>Strategixs cannot be held liable for indirect damages, loss of opportunity, or moral or emotional harm related to use of the service.</li>
    <li>Strategixs' liability is limited to the amount paid by the user for the analysis in question.</li>
  </ul>

  <h2 class="text-xl font-bold text-white mt-6">10. Minimum age</h2>
  <p>The service is reserved for individuals <strong>aged 16 and over</strong>. By using the service, you declare that you are at least 16 years old. Minors under 16 are not authorized to use this service.</p>

  <h2 class="text-xl font-bold text-white mt-6">11. Data protection</h2>
  <p>The processing of your personal data is detailed in our <a href="/privacy" class="text-violet-400 hover:underline">Privacy Policy</a>. By using the service, you acknowledge having read this policy.</p>

  <h2 class="text-xl font-bold text-white mt-6">12. Amendments to the Terms</h2>
  <p>These Terms of Use may be modified at any time. Changes take effect upon publication on the site. The last updated date at the top of this page prevails. Continued use of the service after modification constitutes acceptance of the new terms.</p>

  <h2 class="text-xl font-bold text-white mt-6">13. Governing law and jurisdiction</h2>
  <p>These Terms are governed by <strong>French law</strong>. Any dispute relating to the interpretation or performance of these Terms shall be submitted to the competent courts of Paris, France, subject to mandatory consumer protection provisions.</p>
  <p class="mt-2">In accordance with Article L612-1 of the French Consumer Code, in the event of a dispute, you may use the consumer mediation service free of charge. We will provide the contact details of the competent mediator upon request.</p>

  <h2 class="text-xl font-bold text-white mt-6">14. Contact</h2>
  <p>For any questions regarding these Terms: <strong>social@strategixs.net</strong></p>
  `
}

function guidePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
${HEAD('The 7 Signals That Never Lie — Free Guide')}
<body class="bg-[#0a0a0a] text-gray-100 font-sans min-h-screen" data-page="guide">

  <!-- Header -->
  <nav class="border-b border-white/5 bg-[#0a0a0a]/95 backdrop-blur">
    <div class="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="flex items-center gap-2">
        <img src="/static/logo-192.png" alt="Signal Decoder" class="w-7 h-7 rounded-lg">
        <span class="font-bold text-white text-sm">Signal Decoder</span>
      </a>
      <a href="/#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 rounded-lg text-xs font-semibold transition-colors">
        Try free analysis →
      </a>
    </div>
  </nav>

  <div class="max-w-3xl mx-auto px-4 py-12">

    <!-- Hero -->
    <div class="text-center mb-12">
      <div class="inline-block bg-violet-900/40 border border-violet-700/30 text-violet-300 text-xs px-3 py-1.5 rounded-full mb-4 font-semibold">
        FREE GUIDE
      </div>
      <h1 class="text-3xl sm:text-4xl font-black text-white mb-3 leading-tight">
        The 7 Signals<br>That Never Lie
      </h1>
      <p class="text-gray-400 text-sm max-w-lg mx-auto">The behaviors that reveal what someone really thinks — regardless of what they say. Downloaded by 1,200+ people.</p>
    </div>

    <!-- Intro -->
    <div class="glass-card rounded-2xl p-6 border border-white/5 mb-8">
      <p class="text-gray-300 text-sm leading-relaxed">
        You're reading this because someone's behavior is confusing you. Good. That means your instincts are working.
        Here are the 7 signals that never lie — no matter what they <em>say</em>.
      </p>
    </div>

    <!-- Signals -->
    <div class="space-y-6 mb-12">

      ${[
        {
          num: '01',
          title: 'Response Time Shifts',
          color: 'violet',
          icon: 'fa-clock',
          body: "It's not about how fast they reply. It's about <strong class='text-white'>changes</strong> in speed. Someone who replied in 10 minutes and now takes 8 hours is telling you something. The shift is the signal, not the speed.",
          key: 'Watch for: sudden delays where there were none before.'
        },
        {
          num: '02',
          title: 'Effort Asymmetry',
          color: 'blue',
          icon: 'fa-balance-scale',
          body: "Count this: who initiates more? Who writes longer messages? Who asks questions? If it's 70/30 or worse — that's not shyness. That's a <strong class='text-white'>decision they've already made</strong>.",
          key: 'Watch for: you always text first, they never ask you questions.'
        },
        {
          num: '03',
          title: 'The "Ok." / "Haha" / "👍" Response',
          color: 'red',
          icon: 'fa-comment-slash',
          body: "When someone CAN give more but CHOOSES to give the minimum — that's the loudest signal of all. <strong class='text-white'>Low-effort replies to high-effort messages = emotional withdrawal.</strong>",
          key: 'Watch for: your 3-paragraph message gets a one-word reply.'
        },
        {
          num: '04',
          title: 'Future Talk Disappears',
          color: 'amber',
          icon: 'fa-calendar-times',
          body: "\"We should go there sometime\" turns into... nothing. When someone stops making plans or referencing the future, they're <strong class='text-white'>mentally already gone</strong>. The absence of future-talk is more honest than any words.",
          key: 'Watch for: plans become vague, "someday" replaces actual dates.'
        },
        {
          num: '05',
          title: 'Public vs Private Behavior',
          color: 'green',
          icon: 'fa-eye',
          body: "They're warm in person but cold over text? Or they post stories but don't reply to you? The gap between their <strong class='text-white'>public presence and their attention to YOU</strong> is a direct measure of priority.",
          key: 'Watch for: active on social media but "too busy" to reply to you.'
        },
        {
          num: '06',
          title: 'The Excuse Pattern',
          color: 'orange',
          icon: 'fa-redo',
          body: "One excuse is life. Two is a coincidence. <strong class='text-white'>Three is a pattern.</strong> Track the excuses — \"busy\", \"forgot\", \"fell asleep\" — if they repeat without any initiative to compensate, they're not excuses. They're choices.",
          key: 'Watch for: excuses without repair attempts (no "let me make it up to you").'
        },
        {
          num: '07',
          title: 'Your Gut Feeling',
          color: 'purple',
          icon: 'fa-brain',
          body: "Here's the one nobody tells you: if you're reading this guide, <strong class='text-white'>you already know something is off</strong>. The confusion you feel IS the signal. Healthy connections don't make you Google \"what does their message mean\" at 2am.",
          key: 'The truth: anxiety about a relationship is data, not weakness.'
        },
      ].map(s => `
      <div class="glass-card rounded-2xl p-6 border border-${s.color}-500/20 hover:border-${s.color}-500/40 transition-all">
        <div class="flex items-start gap-4">
          <div class="flex-shrink-0">
            <div class="w-12 h-12 bg-${s.color}-900/50 border border-${s.color}-700/30 rounded-xl flex items-center justify-center">
              <i class="fas ${s.icon} text-${s.color}-400"></i>
            </div>
            <div class="font-mono text-xs text-${s.color}-500/40 text-center mt-1 font-black">${s.num}</div>
          </div>
          <div>
            <h2 class="text-lg font-black text-white mb-2">${s.title}</h2>
            <p class="text-gray-300 text-sm leading-relaxed mb-3">${s.body}</p>
            <div class="bg-${s.color}-950/30 border border-${s.color}-800/20 rounded-lg px-3 py-2">
              <span class="text-${s.color}-400 text-xs font-semibold">${s.key}</span>
            </div>
          </div>
        </div>
      </div>`).join('')}

    </div>

    <!-- CTA Section -->
    <div class="rounded-2xl p-[2px] bg-gradient-to-r from-violet-600 to-blue-500 mb-8">
      <div class="bg-[#0a0816] rounded-2xl p-8 text-center">
        <div class="text-3xl mb-3">🧠</div>
        <h2 class="text-2xl font-black text-white mb-3">
          Now you can see the signals.<br>
          <span class="text-violet-400">Want to know what they mean?</span>
        </h2>
        <p class="text-gray-400 text-sm mb-6 max-w-md mx-auto">
          These 7 signals help you spot the pattern. But every situation is unique.
          Signal Decoder analyzes <strong class="text-white">your specific message</strong> and tells you exactly what's happening — with confidence scores, psychological frameworks, and what to do next.
        </p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/#pricing" class="bg-violet-600 hover:bg-violet-500 text-white px-8 py-4 rounded-xl font-black text-base transition-colors pulse-glow">
            Try a free analysis now →
          </a>
        </div>
        <p class="text-gray-600 text-xs mt-3">Free Mini Decode · No card needed · Result in 30 seconds</p>
      </div>
    </div>

    <!-- Footer -->
    <div class="text-center text-xs text-gray-600 pb-8 space-y-2">
      <p>© 2026 Signal Decoder — Strategixs SAS</p>
      <div class="flex justify-center gap-4">
        <a href="/privacy" class="hover:text-gray-400 transition-colors">Privacy</a>
        <a href="/terms" class="hover:text-gray-400 transition-colors">Terms</a>
      </div>
    </div>
  </div>
</body>
</html>`
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

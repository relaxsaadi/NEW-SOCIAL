// Social Signal Translator — Frontend App JS v2 (Hormozi Edition)

// ── Utils ─────────────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel)
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)]
const on = (el, ev, fn) => el?.addEventListener(ev, fn)

function showToast(msg, type = 'info') {
  const toast = document.createElement('div')
  const colors = { info: 'bg-blue-900 border-blue-700', error: 'bg-red-900 border-red-700', success: 'bg-green-900 border-green-700' }
  toast.className = `fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl border text-sm text-white shadow-xl transition-all duration-300 ${colors[type] || colors.info}`
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300) }, 3000)
}

function setLoading(btn, loading, text = 'Loading...') {
  if (!btn) return
  btn.disabled = loading
  btn.dataset.originalText = btn.dataset.originalText || btn.textContent
  btn.textContent = loading ? text : btn.dataset.originalText
}

// ── Live Counter (Hormozi: social proof + FOMO) ───────────────────────────────
function initLiveCounter() {
  // Simulate a realistic live user count
  const baseCount = 47
  let current = baseCount + Math.floor(Math.random() * 10)

  const liveCountEl = $('#live-count')
  const navCountEl = $('#nav-count')
  const heroCountEl = $('#hero-count')

  function updateCount() {
    const delta = Math.random() > 0.5 ? 1 : -1
    current = Math.max(32, Math.min(89, current + delta))
    if (liveCountEl) liveCountEl.textContent = current
    if (navCountEl) navCountEl.textContent = `${current} online`
  }

  // Animate the hero count (total analyses)
  if (heroCountEl) {
    let heroVal = 2700
    const heroTarget = 2847
    const heroInterval = setInterval(() => {
      heroVal = Math.min(heroTarget, heroVal + Math.floor(Math.random() * 8) + 3)
      heroCountEl.textContent = `+${heroVal.toLocaleString('en-US')}`
      if (heroVal >= heroTarget) clearInterval(heroInterval)
    }, 40)
  }

  setInterval(updateCount, 4500)
}

// ── Scarcity Timer (Hormozi: urgency without lying) ───────────────────────────
function initScarcityTimer() {
  // Exit popup gets its own 10-minute countdown that starts fresh on page load
  const POPUP_DURATION = 10 * 60 * 1000 // 10 min
  const popupStart = Date.now()
  const exitCountdownEl = $('#exit-countdown')

  function updateTimer() {
    if (!exitCountdownEl) return
    const elapsed = Date.now() - popupStart
    const remaining = Math.max(0, POPUP_DURATION - elapsed)
    const mins = Math.floor(remaining / 60000)
    const secs = Math.floor((remaining % 60000) / 1000)
    exitCountdownEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  updateTimer()
  setInterval(updateTimer, 1000)
}

// ── Exit Intent Popup (Hormozi: catch the 70% who almost left) ────────────────
function initExitIntent() {
  const popup = $('#exit-popup')
  if (!popup) return

  let shown = false
  let mouseLeft = false

  document.addEventListener('mouseleave', (e) => {
    if (e.clientY <= 5 && !shown && !mouseLeft) {
      shown = true
      mouseLeft = true
      setTimeout(() => {
        popup.classList.remove('hidden')
        popup.classList.add('flex')
      }, 300)
    }
  })

  // Also show on mobile after scroll past pricing + scroll back up
  let maxScroll = 0
  window.addEventListener('scroll', () => {
    if (window.scrollY > maxScroll) maxScroll = window.scrollY
    if (maxScroll > 800 && window.scrollY < 100 && !shown) {
      shown = true
      popup.classList.remove('hidden')
      popup.classList.add('flex')
    }
  })
}

// ── Checkout Flow ─────────────────────────────────────────────────────────────
function initCheckoutButtons() {
  $$('[data-offer]').forEach(btn => {
    on(btn, 'click', async () => {
      const offerType = btn.dataset.offer

      // Micro-interaction: button state feedback
      const originalText = btn.textContent
      btn.textContent = '⏳ Processing...'
      btn.disabled = true

      // Free Mini Decode — different flow (no Stripe)
      if (offerType === 'mini_decode') {
        const email = $('[name="free-email"]')?.value?.trim()
        if (!email) {
          showToast('Please enter your email first', 'error')
          btn.textContent = originalText
          btn.disabled = false
          return
        }
        try {
          const res = await fetch('/api/create-free-analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          const data = await res.json()
          if (data.redirectUrl) {
            window.location.href = data.redirectUrl
          } else {
            showToast(data.message || 'Error creating analysis', 'error')
            btn.textContent = originalText
            btn.disabled = false
          }
        } catch (e) {
          showToast('Connection error', 'error')
          btn.textContent = originalText
          btn.disabled = false
        }
        return
      }

      // Paid offers — Stripe checkout
      const email = $('[name="email"]')?.value?.trim()
      try {
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offerType, email: email || undefined, locale: 'en' }),
        })
        const data = await res.json()
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl
        } else {
          showToast(data.message || 'Payment error', 'error')
          btn.textContent = originalText
          btn.disabled = false
        }
      } catch (e) {
        showToast('Connection error', 'error')
        btn.textContent = originalText
        btn.disabled = false
      }
    })
  })
}

// ── Checkout Success Page ─────────────────────────────────────────────────────
async function initCheckoutSuccess() {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('session_id')
  const statusEl = $('#checkout-status')
  const spinnerEl = $('#checkout-spinner')

  if (!sessionId) {
    window.location.href = '/'
    return
  }

  let attempts = 0
  const poll = async () => {
    attempts++
    try {
      const res = await fetch(`/api/checkout-status?session_id=${sessionId}`)
      const data = await res.json()

      if (data.analysisId && data.status === 'paid') {
        if (statusEl) statusEl.textContent = 'Payment confirmed! Redirecting...'
        setTimeout(() => window.location.href = `/intake/${data.analysisId}`, 1000)
      } else if (attempts < 15) {
        setTimeout(poll, 2000)
      } else {
        if (statusEl) statusEl.textContent = 'Verifying... Please wait.'
        setTimeout(poll, 5000)
      }
    } catch {
      if (attempts < 10) setTimeout(poll, 3000)
    }
  }
  poll()
}

// ── Intake Form ───────────────────────────────────────────────────────────────
function initIntakeForm() {
  const form = $('#intake-form')
  if (!form) return

  const analysisId = form.dataset.analysisId
  const charCount = $('#char-count')
  const qualityBar = $('#quality-bar')
  const qualityLabel = $('#quality-label')
  const inputText = $('[name="inputText"]')
  const submitBtn = $('#submit-btn')

  // Quality signal indicator (Hormozi: guide to better input = better output)
  on(inputText, 'input', () => {
    const len = inputText.value.length
    if (charCount) {
      charCount.textContent = `${len}/5000`
      charCount.className = len > 4500 ? 'text-red-400 text-xs' : 'text-gray-500 text-xs'
    }

    // Quality bar
    if (qualityBar && qualityLabel) {
      let quality, color, label
      if (len < 20) {
        quality = Math.min(len / 20 * 15, 15)
        color = 'bg-red-600'
        label = '⚠️ Insufficient signal — add more details'
      } else if (len < 60) {
        quality = 15 + (len - 20) / 40 * 25
        color = 'bg-orange-500'
        label = '📝 Weak signal — keep going...'
      } else if (len < 150) {
        quality = 40 + (len - 60) / 90 * 30
        color = 'bg-amber-500'
        label = '🔍 Medium signal — add context'
      } else if (len < 300) {
        quality = 70 + (len - 150) / 150 * 20
        color = 'bg-green-500'
        label = '✅ Good signal — accurate verdict guaranteed'
      } else {
        quality = 90 + Math.min((len - 300) / 200 * 10, 10)
        color = 'bg-emerald-500'
        label = '🎯 Excellent signal — high-confidence verdict'
      }
      qualityBar.style.width = `${Math.min(quality, 100)}%`
      qualityBar.className = `h-1 rounded-full transition-all duration-300 ${color}`
      qualityLabel.textContent = label
      qualityLabel.className = `text-xs mb-2 ${color.replace('bg-', 'text-').replace('-500', '-400').replace('-600', '-400')}`
    }
  })

  // Mode selector
  $$('[data-mode]').forEach(btn => {
    on(btn, 'click', () => {
      $$('[data-mode]').forEach(b => {
        b.classList.remove('ring-2', 'ring-violet-500', 'bg-violet-900/30', 'border-violet-500', 'text-white')
        b.classList.add('border-gray-700/70', 'text-gray-400')
      })
      btn.classList.add('ring-2', 'ring-violet-500', 'bg-violet-900/30', 'border-violet-500', 'text-white')
      btn.classList.remove('border-gray-700/70', 'text-gray-400')
      const modeInput = $('[name="mode"]')
      if (modeInput) modeInput.value = btn.dataset.mode
    })
  })

  on(form, 'submit', async (e) => {
    e.preventDefault()
    const formData = new FormData(form)
    const inputTextVal = formData.get('inputText')?.toString().trim()

    if (!inputTextVal || inputTextVal.length < 10) {
      showToast('Please enter at least 10 characters for a reliable analysis', 'error')
      return
    }

    setLoading(submitBtn, true, '⚡ Analyzing...')

    const payload = {
      analysisId,
      inputText: inputTextVal,
      contextType: formData.get('contextType'),
      mode: formData.get('mode'),
      offerType: formData.get('offerType'),
      extraContext: formData.get('extraContext'),
      goal: formData.get('goal'),
      relationDuration: formData.get('relationDuration'),
    }

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (res.ok && data.status === 'generating') {
        window.location.href = `/processing/${analysisId}`
      } else {
        showToast(data.message || 'Submission error', 'error')
        setLoading(submitBtn, false)
      }
    } catch (e) {
      showToast('Connection error', 'error')
      setLoading(submitBtn, false)
    }
  })
}

// ── Processing Page ───────────────────────────────────────────────────────────
function initProcessingPage() {
  const analysisId = document.body.dataset.analysisId
  if (!analysisId) return

  const progressBar = $('#progress-bar')
  const stepText = $('#step-text')
  const progressPct = $('#progress-pct')

  let progress = 0
  const steps = [
    'Initializing analysis...',
    'Detecting observable signals...',
    'Analyzing timing and tone...',
    'Evaluating behavioral consistency...',
    'Mapping relational dynamics...',
    'Calculating confidence scores...',
    'Generating probabilistic interpretations...',
    'Finalizing personalized report...',
  ]
  let stepIdx = 0

  const progressInterval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 4 + 1
      if (progressBar) progressBar.style.width = `${Math.min(progress, 90)}%`
      if (progressPct) progressPct.textContent = `${Math.floor(Math.min(progress, 90))}%`

      if (Math.random() > 0.65 && stepIdx < steps.length - 1) {
        stepIdx++
        if (stepText) stepText.textContent = steps[stepIdx]
      }
    }
  }, 700)

  let pollAttempts = 0
  const pollResult = async () => {
    pollAttempts++
    try {
      const res = await fetch(`/api/result/${analysisId}`)
      const data = await res.json()

      if (data.status === 'completed') {
        clearInterval(progressInterval)
        if (progressBar) progressBar.style.width = '100%'
        if (progressPct) progressPct.textContent = '100%'
        if (stepText) stepText.textContent = '✅ Analysis complete — report ready!'
        setTimeout(() => window.location.href = `/result/${analysisId}`, 600)
      } else if (data.status === 'failed') {
        clearInterval(progressInterval)
        if (stepText) stepText.textContent = 'Analysis temporarily unavailable.'
        showToast('Analysis error. Your credit is preserved.', 'error')
      } else if (data.status === 'blocked') {
        clearInterval(progressInterval)
        window.location.href = `/result/${analysisId}`
      } else if (pollAttempts < 30) {
        setTimeout(pollResult, 2000)
      } else {
        clearInterval(progressInterval)
        if (stepText) stepText.textContent = 'Timeout. Checking...'
        setTimeout(pollResult, 5000)
      }
    } catch {
      if (pollAttempts < 30) setTimeout(pollResult, 3000)
    }
  }

  setTimeout(pollResult, 3000)
}

// ── Result Page ───────────────────────────────────────────────────────────────
function initResultPage() {
  const scoreEls = $$('[data-score]')
  // Animate score bars on load with stagger
  setTimeout(() => {
    scoreEls.forEach((el, i) => {
      setTimeout(() => {
        const score = parseInt(el.dataset.score)
        const bar = el.querySelector('.score-bar')
        if (bar) bar.style.width = `${score}%`
      }, i * 150)
    })
  }, 400)

  // Upsell button
  const upsellBtn = $('#upsell-btn')
  const analysisId = document.body.dataset.analysisId

  on(upsellBtn, 'click', async () => {
    setLoading(upsellBtn, true, '⏳ Redirecting to payment...')
    try {
      const res = await fetch('/api/create-upsell-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisId }),
      })
      const data = await res.json()
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl
      } else {
        showToast('Payment error', 'error')
        setLoading(upsellBtn, false)
      }
    } catch {
      showToast('Connection error', 'error')
      setLoading(upsellBtn, false)
    }
  })

  // Copy result button
  const copyBtn = $('#copy-btn')
  on(copyBtn, 'click', () => {
    const resultText = $('#result-summary')?.textContent
    if (resultText) {
      navigator.clipboard.writeText(resultText).then(() => {
        showToast('✅ Summary copied!', 'success')
        if (copyBtn) {
          copyBtn.innerHTML = '<i class="fas fa-check mr-1"></i> Copied!'
          setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copy summary' }, 2000)
        }
      })
    }
  })

  // Scroll animation for main reading
  const mainReadingCard = document.querySelector('[class*="bg-\\[#0f0a1a\\]"]')
  if (mainReadingCard) {
    mainReadingCard.style.opacity = '0'
    mainReadingCard.style.transform = 'translateY(10px)'
    setTimeout(() => {
      mainReadingCard.style.transition = 'all 0.5s ease'
      mainReadingCard.style.opacity = '1'
      mainReadingCard.style.transform = 'translateY(0)'
    }, 600)
  }
}

// ── Lead capture ──────────────────────────────────────────────────────────────
function setupLeadForm(form, emailSelector, source) {
  on(form, 'submit', async (e) => {
    e.preventDefault()
    const email = $(emailSelector)?.value?.trim()
    if (!email) return

    const submitBtn = form.querySelector('[type="submit"]')
    if (submitBtn) { submitBtn.textContent = '⏳ Sending...'; submitBtn.disabled = true }

    try {
      await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source }),
      })
      showToast('✅ Guide sent! Check your inbox.', 'success')
      form.reset()
      form.innerHTML = `<div class="text-center py-2">
        <div class="text-green-400 font-bold text-sm"><i class="fas fa-check-circle mr-1"></i>Guide sent to ${email}</div>
        <div class="text-gray-500 text-xs mt-1">Check your inbox (and spam folder)</div>
      </div>`
    } catch {
      if (submitBtn) { submitBtn.textContent = 'Get the guide →'; submitBtn.disabled = false }
    }
  })
}

function initLeadCapture() {
  const leadForm = $('#lead-form')
  if (leadForm) setupLeadForm(leadForm, '[name="lead-email"]', 'landing_lead_magnet')

  const inlineForm = $('#lead-form-inline')
  if (inlineForm) setupLeadForm(inlineForm, '[name="lead-email-inline"]', 'landing_inline')
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page

  // Global init (all pages)
  initCheckoutButtons()
  initLeadCapture()

  // Landing page specific
  if (page === 'landing') {
    initLiveCounter()
    initScarcityTimer()
    initExitIntent()
  }

  // Page-specific
  if (page === 'checkout-success') initCheckoutSuccess()
  if (page === 'intake') initIntakeForm()
  if (page === 'processing') initProcessingPage()
  if (page === 'result') initResultPage()
})

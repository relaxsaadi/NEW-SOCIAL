// Social Signal Translator — Frontend App JS

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

function setLoading(btn, loading, text = 'Chargement...') {
  if (!btn) return
  btn.disabled = loading
  btn.dataset.originalText = btn.dataset.originalText || btn.textContent
  btn.textContent = loading ? text : btn.dataset.originalText
}

// ── Checkout Flow ─────────────────────────────────────────────────────────────
function initCheckoutButtons() {
  $$('[data-offer]').forEach(btn => {
    on(btn, 'click', async () => {
      const offerType = btn.dataset.offer
      const email = $('[name="email"]')?.value?.trim()

      setLoading(btn, true, 'Redirection vers paiement...')

      try {
        const res = await fetch('/api/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ offerType, email: email || undefined, locale: 'fr' }),
        })
        const data = await res.json()
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl
        } else {
          showToast(data.message || 'Erreur lors du paiement', 'error')
          setLoading(btn, false)
        }
      } catch (e) {
        showToast('Erreur de connexion', 'error')
        setLoading(btn, false)
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

  // Poll until we find the analysis
  let attempts = 0
  const poll = async () => {
    attempts++
    try {
      const res = await fetch(`/api/checkout-status?session_id=${sessionId}`)
      const data = await res.json()

      if (data.analysisId && data.status === 'paid') {
        if (statusEl) statusEl.textContent = 'Paiement confirmé ! Redirection...'
        setTimeout(() => window.location.href = `/intake/${data.analysisId}`, 1000)
      } else if (attempts < 15) {
        setTimeout(poll, 2000)
      } else {
        if (statusEl) statusEl.textContent = 'Vérification en cours... Veuillez patienter.'
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
  const inputText = $('[name="inputText"]')
  const submitBtn = $('#submit-btn')

  // Character counter
  on(inputText, 'input', () => {
    const len = inputText.value.length
    if (charCount) {
      charCount.textContent = `${len}/5000`
      charCount.className = len > 4500 ? 'text-red-400 text-xs' : 'text-gray-500 text-xs'
    }
  })

  // Mode selector
  $$('[data-mode]').forEach(btn => {
    on(btn, 'click', () => {
      $$('[data-mode]').forEach(b => b.classList.remove('ring-2', 'ring-violet-500', 'bg-violet-900/30'))
      btn.classList.add('ring-2', 'ring-violet-500', 'bg-violet-900/30')
      const modeInput = $('[name="mode"]')
      if (modeInput) modeInput.value = btn.dataset.mode
    })
  })

  on(form, 'submit', async (e) => {
    e.preventDefault()
    const formData = new FormData(form)
    const inputTextVal = formData.get('inputText')?.toString().trim()

    if (!inputTextVal || inputTextVal.length < 10) {
      showToast('Veuillez entrer au moins 10 caractères', 'error')
      return
    }

    setLoading(submitBtn, true, 'Envoi en cours...')

    const payload = {
      analysisId,
      inputText: inputTextVal,
      contextType: formData.get('contextType'),
      mode: formData.get('mode'),
      offerType: formData.get('offerType'),
      extraContext: formData.get('extraContext'),
      goal: formData.get('goal'),
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
        showToast(data.message || 'Erreur lors de la soumission', 'error')
        setLoading(submitBtn, false)
      }
    } catch (e) {
      showToast('Erreur de connexion', 'error')
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
    'Initialisation de l\'analyse...',
    'Détection des signaux observables...',
    'Analyse du ton émotionnel...',
    'Évaluation de la cohérence...',
    'Cartographie des dynamiques...',
    'Calcul des scores de confiance...',
    'Génération des interprétations...',
    'Finalisation du rapport...',
  ]
  let stepIdx = 0

  // Fake progress animation
  const progressInterval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 5
      if (progressBar) progressBar.style.width = `${Math.min(progress, 90)}%`
      if (progressPct) progressPct.textContent = `${Math.floor(Math.min(progress, 90))}%`

      if (Math.random() > 0.7 && stepIdx < steps.length - 1) {
        stepIdx++
        if (stepText) stepText.textContent = steps[stepIdx]
      }
    }
  }, 800)

  // Poll for result
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
        if (stepText) stepText.textContent = 'Analyse terminée !'
        setTimeout(() => window.location.href = `/result/${analysisId}`, 800)
      } else if (data.status === 'failed') {
        clearInterval(progressInterval)
        if (stepText) stepText.textContent = 'Analyse temporairement indisponible.'
        showToast('Erreur lors de l\'analyse. Votre crédit est préservé.', 'error')
      } else if (data.status === 'blocked') {
        clearInterval(progressInterval)
        window.location.href = `/result/${analysisId}`
      } else if (pollAttempts < 30) {
        setTimeout(pollResult, 2000)
      } else {
        clearInterval(progressInterval)
        if (stepText) stepText.textContent = 'Délai dépassé. Vérification dans quelques instants...'
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
  // Animate score bars on load
  setTimeout(() => {
    scoreEls.forEach(el => {
      const score = parseInt(el.dataset.score)
      const bar = el.querySelector('.score-bar')
      if (bar) bar.style.width = `${score}%`
    })
  }, 300)

  // Upsell button
  const upsellBtn = $('#upsell-btn')
  const analysisId = document.body.dataset.analysisId

  on(upsellBtn, 'click', async () => {
    setLoading(upsellBtn, true, 'Redirection...')
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
        showToast('Erreur lors du paiement', 'error')
        setLoading(upsellBtn, false)
      }
    } catch {
      showToast('Erreur de connexion', 'error')
      setLoading(upsellBtn, false)
    }
  })

  // Copy result button
  const copyBtn = $('#copy-btn')
  on(copyBtn, 'click', () => {
    const resultText = $('#result-summary')?.textContent
    if (resultText) {
      navigator.clipboard.writeText(resultText).then(() => showToast('Copié !', 'success'))
    }
  })
}

// ── Lead capture ──────────────────────────────────────────────────────────────
function initLeadCapture() {
  const leadForm = $('#lead-form')
  on(leadForm, 'submit', async (e) => {
    e.preventDefault()
    const email = $('[name="lead-email"]')?.value?.trim()
    if (!email) return

    try {
      await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'landing_hero' }),
      })
      showToast('Merci ! Vous recevrez nos conseils.', 'success')
      leadForm.reset()
    } catch {}
  })
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page

  initCheckoutButtons()
  initLeadCapture()

  if (page === 'checkout-success') initCheckoutSuccess()
  if (page === 'intake') initIntakeForm()
  if (page === 'processing') initProcessingPage()
  if (page === 'result') initResultPage()
})

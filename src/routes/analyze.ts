import { Hono } from 'hono'
import type { Bindings, AnalysisMode, ContextType, OfferType } from '../lib/types'
import { ulid, now, logEvent } from '../lib/db'
import { callLLM, isSafetyBlock } from '../lib/llm'

const analyze = new Hono<{ Bindings: Bindings }>()

// POST /api/analyze — soumettre le formulaire d'intake
analyze.post('/api/analyze', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    analysisId?: string
    inputText?: string
    contextType?: ContextType
    mode?: AnalysisMode
    offerType?: OfferType
    extraContext?: string
    goal?: string
    timingContext?: string
    userQuestion?: string
  }

  const { analysisId, inputText, contextType, mode, offerType } = body

  if (!analysisId) return c.json({ error: 'MISSING_ID', message: 'analysisId is required' }, 400)
  if (!inputText || inputText.trim().length < 10) {
    return c.json({ error: 'INPUT_TOO_SHORT', message: 'inputText must be at least 10 characters' }, 400)
  }
  if (inputText.length > 5000) {
    return c.json({ error: 'INPUT_TOO_LONG', message: 'inputText exceeds 5000 characters' }, 400)
  }

  // Fetch analysis from DB
  const analysis = await c.env.DB.prepare(
    `SELECT id, status, offer_type, mode, user_id FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{ id: string; status: string; offer_type: string; mode: string; user_id: string }>()

  if (!analysis) return c.json({ error: 'NOT_FOUND', message: 'Analysis not found' }, 404)

  if (!['paid', 'intake_pending', 'failed'].includes(analysis.status)) {
    return c.json({ error: 'NOT_PAID', message: 'Analysis not in paid status' }, 403)
  }

  const ts = now()
  const resolvedMode = (mode ?? analysis.mode ?? 'message_decode') as AnalysisMode
  const resolvedOffer = (offerType ?? analysis.offer_type) as OfferType

  // Update to generating
  await c.env.DB.prepare(
    `UPDATE analyses SET status = 'generating', input_text = ?, extra_context = ?, goal = ?, context_type = ?, mode = ?, updated_at = ? WHERE id = ?`
  ).bind(
    inputText,
    body.extraContext ?? null,
    body.goal ?? null,
    contextType ?? analysis.mode,
    resolvedMode,
    ts,
    analysisId
  ).run()

  await logEvent(c.env.DB, 'analysis_started', { analysis_id: analysisId })

  // Run LLM asynchronously using waitUntil if available
  const llmConfig = {
    apiKey: c.env.LLM_API_KEY,
    model: c.env.LLM_MODEL || 'gpt-4o-mini',
    baseUrl: c.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  }

  // Use ctx.waitUntil for async processing
  c.executionCtx?.waitUntil(
    runAnalysis(c.env.DB, analysisId, llmConfig, {
      offerType: resolvedOffer,
      mode: resolvedMode,
      contextType,
      goal: body.goal,
      inputText,
      extraContext: body.extraContext,
      timingContext: body.timingContext,
      userQuestion: body.userQuestion,
    })
  )

  return c.json({ status: 'generating', analysisId, estimatedSeconds: 15 }, 202)
})

async function runAnalysis(
  db: D1Database,
  analysisId: string,
  llmConfig: { apiKey: string; model: string; baseUrl: string },
  input: {
    offerType: OfferType
    mode: AnalysisMode
    contextType?: ContextType
    goal?: string
    inputText: string
    extraContext?: string
    timingContext?: string
    userQuestion?: string
  }
) {
  const ts = now()
  let result: unknown
  let attempt = 0
  const maxAttempts = 2

  while (attempt < maxAttempts) {
    try {
      result = await callLLM(llmConfig, { ...input, language: 'fr' })
      break
    } catch (e) {
      attempt++
      if (attempt >= maxAttempts) {
        await db.prepare(
          `UPDATE analyses SET status = 'failed', updated_at = ? WHERE id = ?`
        ).bind(ts, analysisId).run()
        await logEvent(db, 'analysis_failed', { analysis_id: analysisId, payload: { error: String(e) } })
        return
      }
    }
  }

  if (!result) return

  const resultJson = result as Record<string, unknown>

  // Check safety block
  if (isSafetyBlock(result)) {
    await db.prepare(
      `UPDATE analyses SET status = 'blocked', ai_result_json = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(result), ts, analysisId).run()
    await logEvent(db, 'analysis_blocked', { analysis_id: analysisId })
    return
  }

  // Extract confidence score
  const scores = resultJson.scores as Record<string, number> | undefined
  const confidence = scores
    ? (Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length / 100)
    : 0.7

  await db.prepare(
    `UPDATE analyses SET status = 'completed', ai_result_json = ?, confidence_score = ?, updated_at = ? WHERE id = ?`
  ).bind(JSON.stringify(result), confidence, ts, analysisId).run()

  await logEvent(db, 'analysis_generated', { analysis_id: analysisId })
}

// GET /api/result/:id
analyze.get('/api/result/:id', async (c) => {
  const id = c.req.param('id')

  const analysis = await c.env.DB.prepare(
    `SELECT id, status, offer_type, mode, ai_result_json, confidence_score FROM analyses WHERE id = ?`
  ).bind(id).first<{
    id: string
    status: string
    offer_type: string
    mode: string
    ai_result_json: string | null
    confidence_score: number | null
  }>()

  if (!analysis) return c.json({ error: 'NOT_FOUND' }, 404)

  if (analysis.status === 'completed' && analysis.ai_result_json) {
    // Check if upsell was purchased
    const upsell = await c.env.DB.prepare(
      `SELECT status FROM upsells WHERE analysis_id = ? AND upsell_type = 'reply_generator'`
    ).bind(id).first<{ status: string }>()

    return c.json({
      status: 'completed',
      offerType: analysis.offer_type,
      mode: analysis.mode,
      result: JSON.parse(analysis.ai_result_json),
      upsellAvailable: !upsell || upsell.status === 'offered',
      upsellPurchased: upsell?.status === 'purchased',
      upsellType: 'reply_generator',
    })
  }

  if (analysis.status === 'blocked') {
    return c.json({
      status: 'blocked',
      reason: 'SAFETY_POLICY',
      message: 'Ce contenu ne peut pas être analysé. Si vous traversez une période difficile, des ressources sont disponibles.',
      resources: ['https://www.3114.fr', 'https://www.psychologues.org'],
    })
  }

  if (analysis.status === 'failed') {
    return c.json({
      status: 'failed',
      message: 'Analyse temporairement indisponible — votre crédit est préservé.',
    })
  }

  if (analysis.status === 'generating') {
    return c.json({
      status: 'generating',
      progress: Math.floor(Math.random() * 40) + 30,
      currentStep: getRandomStep(),
    })
  }

  return c.json({ status: analysis.status })
})

// POST /api/generate-reply
analyze.post('/api/generate-reply', async (c) => {
  const { analysisId, preferredStyle } = await c.req.json() as {
    analysisId?: string
    preferredStyle?: string
  }

  if (!analysisId) return c.json({ error: 'MISSING_ID' }, 400)

  const analysis = await c.env.DB.prepare(
    `SELECT id, status, ai_result_json, offer_type, mode, context_type, input_text, extra_context, goal FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{
    id: string
    status: string
    ai_result_json: string | null
    offer_type: string
    mode: string
    context_type: string
    input_text: string
    extra_context: string
    goal: string
  }>()

  if (!analysis || analysis.status !== 'completed') {
    return c.json({ error: 'NOT_ELIGIBLE' }, 403)
  }

  // Check upsell purchased
  const upsell = await c.env.DB.prepare(
    `SELECT status FROM upsells WHERE analysis_id = ? AND upsell_type = 'reply_generator'`
  ).bind(analysisId).first<{ status: string }>()

  if (!upsell || upsell.status !== 'purchased') {
    return c.json({ error: 'NOT_PURCHASED', message: 'Reply Generator not purchased' }, 403)
  }

  // If already in the result, return it
  if (analysis.ai_result_json) {
    const result = JSON.parse(analysis.ai_result_json) as { reply_options?: unknown[] }
    if (result.reply_options && result.reply_options.length > 0) {
      return c.json({ replyOptions: result.reply_options })
    }
  }

  // Generate reply options
  const llmConfig = {
    apiKey: c.env.LLM_API_KEY,
    model: c.env.LLM_MODEL || 'gpt-4o-mini',
    baseUrl: c.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  }

  try {
    const result = await callLLM(llmConfig, {
      offerType: analysis.offer_type as OfferType,
      mode: 'reply_generator',
      contextType: analysis.context_type as ContextType,
      goal: analysis.goal,
      inputText: analysis.input_text,
      extraContext: analysis.extra_context,
      language: 'fr',
    })

    const r = result as Record<string, unknown>
    const replyOptions = r.reply_options || []
    return c.json({ replyOptions })
  } catch (e) {
    return c.json({ error: 'GENERATION_FAILED' }, 500)
  }
})

// Webhook upsell payment
analyze.post('/api/webhooks/upsell-paid', async (c) => {
  const { upsellId } = await c.req.json() as { upsellId?: string }
  if (!upsellId) return c.json({ error: 'MISSING_ID' }, 400)

  const ts = now()
  await c.env.DB.prepare(
    `UPDATE upsells SET status = 'purchased', updated_at = ? WHERE id = ?`
  ).bind(ts, upsellId).run()

  return c.json({ success: true })
})

function getRandomStep(): string {
  const steps = [
    'Analyzing semantic patterns...',
    'Detecting emotional tone...',
    'Evaluating signal consistency...',
    'Mapping relational dynamics...',
    'Assessing confidence levels...',
    'Generating interpretations...',
  ]
  return steps[Math.floor(Math.random() * steps.length)]
}

export default analyze

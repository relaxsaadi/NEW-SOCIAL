/**
 * GoHighLevel webhook integration.
 * Sends events to GHL for CRM automation (nurturing, upsell, retargeting).
 */

const GHL_WEBHOOK_URL = 'https://services.leadconnectorhq.com/hooks/WAy1ulfZlMMABol3w1jn/webhook-trigger/d5bfe87d-7939-4e70-8343-47bed458250c'

export type GHLEvent =
  | 'lead_captured'
  | 'checkout_started'
  | 'payment_success'
  | 'analysis_completed'
  | 'analysis_failed'
  | 'upsell_purchased'

interface GHLPayload {
  event: GHLEvent
  email?: string
  first_name?: string
  tags: string[]
  source: string
  custom_fields?: Record<string, string | number>
}

/**
 * Send event to GHL. Fire-and-forget — never blocks the main flow.
 */
export async function sendToGHL(payload: GHLPayload): Promise<void> {
  try {
    await fetch(GHL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
        website: 'signaldecoder.net',
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Silent fail — GHL integration should never break the app
    console.error('[GHL] Webhook failed for event:', payload.event)
  }
}

// ── Helper functions for each event ──────────────────────────────────────────

export function ghlLeadCaptured(email: string, source: string) {
  return sendToGHL({
    event: 'lead_captured',
    email,
    tags: ['lead_guide', 'signal_decoder', `source_${source}`],
    source,
    custom_fields: {
      guide_url: 'https://signaldecoder.net/guide',
      lead_source: source,
    },
  })
}

export function ghlCheckoutStarted(email: string | undefined, offerType: string) {
  return sendToGHL({
    event: 'checkout_started',
    email,
    tags: ['checkout_started', `offer_${offerType}`],
    source: 'checkout',
    custom_fields: { offer_type: offerType },
  })
}

export function ghlPaymentSuccess(email: string, offerType: string, amountCents: number) {
  return sendToGHL({
    event: 'payment_success',
    email,
    tags: ['client', `client_${offerType}`, 'payment_success'],
    source: 'stripe',
    custom_fields: {
      offer_type: offerType,
      amount_paid: amountCents / 100,
      currency: 'EUR',
    },
  })
}

export function ghlAnalysisCompleted(email: string | undefined, offerType: string, confidence: number) {
  return sendToGHL({
    event: 'analysis_completed',
    email,
    tags: ['analysis_done', `offer_${offerType}`],
    source: 'analysis',
    custom_fields: {
      offer_type: offerType,
      confidence_score: Math.round(confidence * 100),
    },
  })
}

export function ghlAnalysisFailed(email: string | undefined, analysisId: string) {
  return sendToGHL({
    event: 'analysis_failed',
    email,
    tags: ['analysis_failed'],
    source: 'analysis',
    custom_fields: { analysis_id: analysisId },
  })
}

export function ghlUpsellPurchased(email: string | undefined, analysisId: string) {
  return sendToGHL({
    event: 'upsell_purchased',
    email,
    tags: ['upsell_reply_generator', 'client_upsell'],
    source: 'upsell',
    custom_fields: {
      analysis_id: analysisId,
      upsell_type: 'reply_generator',
      amount_paid: 9,
    },
  })
}

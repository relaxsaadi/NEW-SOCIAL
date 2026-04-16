import { Hono } from 'hono'
import type { Bindings, OfferType } from '../lib/types'
import { OFFER_PRICES } from '../lib/types'
import { ulid, now, getOrCreateUser, logEvent } from '../lib/db'
import { ghlCheckoutStarted, ghlPaymentSuccess } from '../lib/ghl'

const checkout = new Hono<{ Bindings: Bindings }>()

checkout.post('/api/create-checkout-session', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { offerType, email, mode, contextType, locale } = body as {
    offerType?: OfferType
    email?: string
    mode?: string
    contextType?: string
    locale?: string
  }

  if (!offerType || !OFFER_PRICES[offerType]) {
    return c.json({ error: 'INVALID_OFFER', message: 'offerType must be quick_decode, deep_read or pattern_analysis' }, 400)
  }

  const analysisId = ulid()
  const ts = now()

  try {
    // Get Stripe price ID from env or use amount
    const priceMap: Record<OfferType, string> = {
      quick_decode: c.env.STRIPE_PRICE_QUICK,
      deep_read: c.env.STRIPE_PRICE_DEEP,
      pattern_analysis: c.env.STRIPE_PRICE_PATTERN,
    }

    const appUrl = c.env.APP_URL || 'http://localhost:3000'
    const offer = OFFER_PRICES[offerType]

    // Build Stripe checkout session
    const stripeBody: Record<string, unknown> = {
      mode: 'payment',
      success_url: `${appUrl}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/`,
      client_reference_id: analysisId,
      metadata: {
        analysisId,
        offerType,
        mode: mode ?? '',
        contextType: contextType ?? '',
        locale: locale ?? 'en',
      },
    }

    if (email) {
      stripeBody.customer_email = email
    }

    const priceId = priceMap[offerType]
    if (priceId && priceId !== 'undefined' && priceId !== '') {
      stripeBody.line_items = [{ price: priceId, quantity: 1 }]
    } else {
      // Fallback: use price_data
      stripeBody.line_items = [
        {
          price_data: {
            currency: 'eur',
            unit_amount: offer.cents,
            product_data: {
              name: offer.description,
              description: `Signal Decoder — ${offer.description}`,
            },
          },
          quantity: 1,
        },
      ]
    }

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toFormData(stripeBody),
    })

    if (!stripeRes.ok) {
      const err = await stripeRes.text()
      console.error('Stripe error:', err)
      return c.json({ error: 'STRIPE_ERROR', message: 'Unable to create checkout session' }, 500)
    }

    const session = await stripeRes.json() as { id: string; url: string }

    // Create analysis record
    await c.env.DB.prepare(
      `INSERT INTO analyses (id, offer_type, mode, context_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending_payment', ?, ?)`
    ).bind(analysisId, offerType, mode ?? 'message_decode', contextType ?? 'other', ts, ts).run()

    // Create payment record
    const paymentId = ulid()
    await c.env.DB.prepare(
      `INSERT INTO payments (id, analysis_id, stripe_session_id, amount_cents, status, offer_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`
    ).bind(paymentId, analysisId, session.id, offer.cents, offerType, ts, ts).run()

    await logEvent(c.env.DB, 'checkout_start', { analysis_id: analysisId, payload: { offerType } })
    c.executionCtx?.waitUntil(ghlCheckoutStarted(email, offerType))

    return c.json({ checkoutUrl: session.url, analysisId })
  } catch (e) {
    console.error('Checkout error:', e)
    return c.json({ error: 'INTERNAL_ERROR', message: 'Failed to create checkout session' }, 500)
  }
})

// Stripe webhook
checkout.post('/api/webhooks/stripe', async (c) => {
  const body = await c.req.text()
  const sig = c.req.header('stripe-signature') ?? ''

  // Verify Stripe signature
  try {
    const isValid = await verifyStripeSignature(body, sig, c.env.STRIPE_WEBHOOK_SECRET)
    if (!isValid) {
      return c.json({ error: 'INVALID_SIGNATURE' }, 400)
    }
  } catch (e) {
    return c.json({ error: 'SIGNATURE_ERROR' }, 400)
  }

  const event = JSON.parse(body) as { type: string; id: string; data: { object: Record<string, unknown> } }

  // Idempotency check
  const existing = await c.env.DB.prepare(
    `SELECT id FROM events_logs WHERE event_name = ? AND event_payload_json LIKE ?`
  ).bind('stripe_webhook', `%${event.id}%`).first()

  if (existing) {
    return c.json({ received: true, duplicate: true })
  }

  const ts = now()

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as {
      id: string
      client_reference_id: string
      customer_email?: string
      payment_intent?: string
      metadata?: Record<string, string>
    }

    const analysisId = session.client_reference_id || session.metadata?.analysisId
    if (!analysisId) return c.json({ received: true })

    // Create or get user
    let userId: string | null = null
    if (session.customer_email) {
      userId = await getOrCreateUser(c.env.DB, session.customer_email, {
        locale: session.metadata?.locale,
      })
      await c.env.DB.prepare(`UPDATE analyses SET user_id = ?, updated_at = ? WHERE id = ?`)
        .bind(userId, ts, analysisId).run()
    }

    // Update analysis status
    await c.env.DB.prepare(
      `UPDATE analyses SET status = 'paid', updated_at = ? WHERE id = ?`
    ).bind(ts, analysisId).run()

    // Update payment
    await c.env.DB.prepare(
      `UPDATE payments SET status = 'paid', stripe_payment_intent_id = ?, user_id = ?, updated_at = ? WHERE stripe_session_id = ?`
    ).bind(session.payment_intent ?? null, userId, ts, session.id).run()

    await logEvent(c.env.DB, 'payment_success', {
      analysis_id: analysisId,
      user_id: userId ?? undefined,
      payload: { stripe_event_id: event.id },
    })

    // Send to GHL — tag as client with offer type
    const offerType = session.metadata?.offerType || 'unknown'
    const paymentRow = await c.env.DB.prepare(
      `SELECT amount_cents FROM payments WHERE stripe_session_id = ?`
    ).bind(session.id).first<{ amount_cents: number }>()
    c.executionCtx?.waitUntil(
      ghlPaymentSuccess(session.customer_email || '', offerType, paymentRow?.amount_cents || 0)
    )
  } else if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object as { id: string }
    await c.env.DB.prepare(
      `UPDATE payments SET status = 'failed', updated_at = ? WHERE stripe_payment_intent_id = ?`
    ).bind(ts, pi.id).run()
  } else if (event.type === 'charge.refunded') {
    const charge = event.data.object as { payment_intent: string }
    const payment = await c.env.DB.prepare(
      `SELECT analysis_id FROM payments WHERE stripe_payment_intent_id = ?`
    ).bind(charge.payment_intent).first<{ analysis_id: string }>()

    if (payment) {
      await c.env.DB.prepare(`UPDATE payments SET status = 'refunded', updated_at = ? WHERE stripe_payment_intent_id = ?`)
        .bind(ts, charge.payment_intent).run()
      await logEvent(c.env.DB, 'payment_refunded', { analysis_id: payment.analysis_id })
    }
  }

  // Log the event
  await logEvent(c.env.DB, 'stripe_webhook', { payload: { event_id: event.id, type: event.type } })

  return c.json({ received: true })
})

// Upsell checkout
checkout.post('/api/create-upsell-session', async (c) => {
  const { analysisId } = await c.req.json() as { analysisId?: string }
  if (!analysisId) return c.json({ error: 'MISSING_ANALYSIS_ID' }, 400)

  const analysis = await c.env.DB.prepare(
    `SELECT id, status, offer_type, user_id FROM analyses WHERE id = ?`
  ).bind(analysisId).first<{ id: string; status: string; offer_type: string; user_id: string }>()

  if (!analysis || analysis.status !== 'completed') {
    return c.json({ error: 'NOT_ELIGIBLE', message: 'Analysis not completed' }, 403)
  }

  const appUrl = c.env.APP_URL || 'http://localhost:3000'
  const upsellId = ulid()
  const ts = now()

  const stripeBody: Record<string, unknown> = {
    mode: 'payment',
    success_url: `${appUrl}/result/${analysisId}?upsell=success`,
    cancel_url: `${appUrl}/upsell/${analysisId}`,
    client_reference_id: upsellId,
    metadata: { analysisId, upsellId, type: 'reply_generator' },
    line_items: [
      {
        price_data: {
          currency: 'eur',
          unit_amount: 900,
          product_data: {
            name: 'Reply Generator',
            description: 'Generate the perfect reply — 3 tone variations',
          },
        },
        quantity: 1,
      },
    ],
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormData(stripeBody),
  })

  if (!stripeRes.ok) {
    return c.json({ error: 'STRIPE_ERROR' }, 500)
  }

  const session = await stripeRes.json() as { id: string; url: string }

  await c.env.DB.prepare(
    `INSERT INTO upsells (id, analysis_id, user_id, upsell_type, amount_cents, stripe_session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'reply_generator', 900, ?, 'offered', ?, ?)`
  ).bind(upsellId, analysisId, analysis.user_id ?? null, session.id, ts, ts).run()

  return c.json({ checkoutUrl: session.url, upsellId })
})

// Helper: convert nested object to URL-encoded form
function toFormData(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v)) {
      parts.push(toFormData(v as Record<string, unknown>, key))
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(toFormData(item as Record<string, unknown>, `${key}[${i}]`))
        } else {
          parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)
        }
      })
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.join('&')
}

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string
): Promise<boolean> {
  if (!header || !secret) return false

  const parts: Record<string, string> = {}
  for (const part of header.split(',')) {
    const [k, v] = part.split('=')
    parts[k] = v
  }

  const timestamp = parts['t']
  const signature = parts['v1']
  if (!timestamp || !signature) return false

  const signedPayload = `${timestamp}.${payload}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload))
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return expected === signature
}

export default checkout

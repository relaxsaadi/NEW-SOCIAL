/**
 * Périmètre du webhook Stripe de Signal Decoder.
 *
 * Le compte Stripe (Strategix SASU) est partagé avec d'autres produits (Tests Canada,
 * Strategix, KostAgent…) : chaque endpoint reçoit TOUS les événements du compte.
 * Ce module décide, en lecture seule, si un événement appartient à Signal Decoder.
 * Tout ce qui n'est pas reconnu doit être ignoré : aucune écriture, aucun appel GHL.
 *
 * Marqueurs fiables, posés par nos propres routes de checkout :
 *  - achat principal : metadata.analysisId + ligne `payments` créée pour CETTE session
 *    (stripe_session_id) et rattachée au même analysis_id ;
 *  - upsell « Reply Generator » : metadata.upsellId + metadata.analysisId + ligne `upsells`
 *    créée pour CETTE session et rattachée au même analysis_id.
 * `client_reference_id` n'est volontairement PAS utilisé : d'autres produits du compte
 * y mettent leurs propres identifiants.
 */

export type StripeScope =
  | { kind: 'purchase'; analysisId: string; amountCents: number }
  | { kind: 'upsell'; analysisId: string; upsellId: string }
  | { kind: 'payment_failed'; paymentIntentId: string }
  | { kind: 'refund'; paymentIntentId: string; analysisId: string }
  | { kind: 'ignored'; reason: string }

type StripeEventLike = { type?: string; data?: { object?: Record<string, unknown> } }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export async function classifyStripeEvent(db: D1Database, event: StripeEventLike): Promise<StripeScope> {
  const obj = (event?.data?.object ?? {}) as Record<string, any>

  if (event?.type === 'checkout.session.completed') {
    const sessionId = str(obj.id)
    const md = (obj.metadata ?? {}) as Record<string, unknown>
    const analysisId = str(md.analysisId)
    if (!sessionId || !analysisId) return { kind: 'ignored', reason: 'not_signal_decoder' }

    const upsellId = str(md.upsellId)
    if (upsellId) {
      const up = await db
        .prepare(`SELECT id FROM upsells WHERE id = ? AND stripe_session_id = ? AND analysis_id = ?`)
        .bind(upsellId, sessionId, analysisId)
        .first<{ id: string }>()
      return up ? { kind: 'upsell', analysisId, upsellId } : { kind: 'ignored', reason: 'unknown_upsell_session' }
    }

    const pay = await db
      .prepare(`SELECT analysis_id, amount_cents FROM payments WHERE stripe_session_id = ?`)
      .bind(sessionId)
      .first<{ analysis_id: string; amount_cents: number }>()
    if (!pay || pay.analysis_id !== analysisId) return { kind: 'ignored', reason: 'unknown_session' }
    return { kind: 'purchase', analysisId, amountCents: Number(pay.amount_cents) || 0 }
  }

  if (event?.type === 'payment_intent.payment_failed') {
    const pi = str(obj.id)
    if (!pi) return { kind: 'ignored', reason: 'no_payment_intent' }
    const pay = await db
      .prepare(`SELECT id FROM payments WHERE stripe_payment_intent_id = ?`)
      .bind(pi)
      .first<{ id: string }>()
    return pay ? { kind: 'payment_failed', paymentIntentId: pi } : { kind: 'ignored', reason: 'unknown_payment_intent' }
  }

  if (event?.type === 'charge.refunded') {
    const pi = str(obj.payment_intent)
    if (!pi) return { kind: 'ignored', reason: 'no_payment_intent' }
    const pay = await db
      .prepare(`SELECT analysis_id FROM payments WHERE stripe_payment_intent_id = ?`)
      .bind(pi)
      .first<{ analysis_id: string }>()
    return pay ? { kind: 'refund', paymentIntentId: pi, analysisId: pay.analysis_id } : { kind: 'ignored', reason: 'unknown_payment_intent' }
  }

  return { kind: 'ignored', reason: 'unhandled_event_type' }
}

import { describe, it, expect, beforeEach, vi } from 'vitest'
import checkout from '../src/routes/checkout'
import { fakeD1 } from './fake-d1'

const SECRET = 'whsec_local_test_only'
async function sign(body: string) {
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  return `t=${t},v1=${Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')}`
}
let ghlCalls: any[] = []
async function post(env: any, event: any) {
  const body = JSON.stringify(event)
  const waits: Promise<unknown>[] = []
  const res = await checkout.request('/api/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': await sign(body) } },
    env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} } as any)
  await Promise.all(waits)
  return { status: res.status, json: await res.json() as any }
}
const evt = (type: string, object: any) => ({ id: 'evt_' + Math.random().toString(36).slice(2), type, data: { object } })

beforeEach(() => {
  ghlCalls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { ghlCalls.push({ url, body: JSON.parse(init.body) }); return new Response('{}') }))
})

describe('webhook Stripe — périmètre Signal Decoder', () => {
  it('ignore une session Tests Canada (client_reference_id uuid, metadata.source, sans analysisId) : aucune écriture, aucun GHL', async () => {
    const { db, writes, tables } = fakeD1()
    const r = await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('checkout.session.completed', {
      id: 'cs_live_tc1', mode: 'payment', payment_status: 'paid', client_reference_id: '11111111-2222-3333-4444-555555555555',
      customer_email: 'eleve@example.com', customer_details: { email: 'eleve@example.com' }, payment_link: 'plink_TC',
      metadata: { source: 'tests-canada', tc_pack_id: 'depart', tc_days: '30' }, amount_total: 1990, currency: 'eur' }))
    expect(r).toEqual({ status: 200, json: { received: true, ignored: true } })
    expect(writes).toEqual([]); expect(tables.users).toEqual([]); expect(ghlCalls).toEqual([])
  })

  it('ignore une session avec un analysisId inconnu (pas de ligne payments pour cette session)', async () => {
    const { db, writes } = fakeD1({ payments: [{ id: 'p1', analysis_id: 'A1', stripe_session_id: 'cs_autre', amount_cents: 700 }] })
    const r = await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('checkout.session.completed', { id: 'cs_x', client_reference_id: 'A1', metadata: { analysisId: 'A1' } }))
    expect(r.json).toEqual({ received: true, ignored: true }); expect(writes).toEqual([]); expect(ghlCalls).toEqual([])
  })

  it('ignore payment_failed et charge.refunded étrangers, sans écriture', async () => {
    const { db, writes } = fakeD1()
    expect((await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('payment_intent.payment_failed', { id: 'pi_tc' }))).json.ignored).toBe(true)
    expect((await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('charge.refunded', { id: 'ch_tc', payment_intent: 'pi_tc' }))).json.ignored).toBe(true)
    expect(writes).toEqual([])
  })

  it('traite une vraie session Signal Decoder : utilisateur, analyse payée, paiement, GHL payment_success', async () => {
    const { db, tables } = fakeD1({ analyses: [{ id: 'A1', status: 'pending_payment' }], payments: [{ id: 'p1', analysis_id: 'A1', stripe_session_id: 'cs_sd1', amount_cents: 700, status: 'created' }] })
    const r = await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('checkout.session.completed', {
      id: 'cs_sd1', client_reference_id: 'A1', customer_email: 'client@example.com', payment_intent: 'pi_sd1',
      metadata: { analysisId: 'A1', offerType: 'quick_decode', locale: 'en' } }))
    expect(r).toEqual({ status: 200, json: { received: true } })
    expect(tables.users).toHaveLength(1)
    expect(tables.analyses[0].status).toBe('paid'); expect(tables.analyses[0].user_id).toBe(tables.users[0].id)
    expect(tables.payments[0]).toMatchObject({ status: 'paid', stripe_payment_intent_id: 'pi_sd1' })
    expect(ghlCalls).toHaveLength(1)
    expect(ghlCalls[0].body).toMatchObject({ event: 'payment_success', email: 'client@example.com', custom_fields: { offer_type: 'quick_decode', amount_paid: 7 } })
    // rejoué : idempotent
    const replayId = JSON.parse(tables.events_logs.find(e => e.event_name === 'stripe_webhook')!.event_payload_json).event_id
    const again = await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, { id: replayId, type: 'checkout.session.completed', data: { object: { id: 'cs_sd1', metadata: { analysisId: 'A1' } } } })
    expect(again.json).toEqual({ received: true, duplicate: true })
  })

  it('traite échec et remboursement d’un paiement Signal Decoder', async () => {
    const { db, tables } = fakeD1({ payments: [{ id: 'p1', analysis_id: 'A1', stripe_session_id: 'cs_sd1', stripe_payment_intent_id: 'pi_sd1', status: 'paid' }] })
    await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('charge.refunded', { id: 'ch1', payment_intent: 'pi_sd1' }))
    expect(tables.payments[0].status).toBe('refunded')
    await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('payment_intent.payment_failed', { id: 'pi_sd1' }))
    expect(tables.payments[0].status).toBe('failed')
  })

  it('upsell Reply Generator reconnu : journalisé, sans changer l’analyse ni envoyer payment_success', async () => {
    const { db, tables } = fakeD1({ analyses: [{ id: 'A1', status: 'completed' }], upsells: [{ id: 'U1', analysis_id: 'A1', stripe_session_id: 'cs_up1', status: 'offered' }] })
    const r = await post({ DB: db, STRIPE_WEBHOOK_SECRET: SECRET }, evt('checkout.session.completed', { id: 'cs_up1', client_reference_id: 'U1', metadata: { analysisId: 'A1', upsellId: 'U1', type: 'reply_generator' } }))
    expect(r.json).toEqual({ received: true })
    expect(tables.analyses[0].status).toBe('completed'); expect(ghlCalls).toEqual([])
    expect(tables.events_logs.map(e => e.event_name)).toEqual(['upsell_payment_webhook', 'stripe_webhook'])
  })

  it('rejette une signature invalide', async () => {
    const { db } = fakeD1()
    const res = await checkout.request('/api/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=00' } }, { DB: db, STRIPE_WEBHOOK_SECRET: SECRET } as any)
    expect(res.status).toBe(400)
  })
})

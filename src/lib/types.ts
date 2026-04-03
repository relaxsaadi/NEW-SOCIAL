export type OfferType = 'quick_decode' | 'deep_read' | 'pattern_analysis'
export type AnalysisMode = 'message_decode' | 'situation_decode' | 'pattern_analysis' | 'reply_generator' | 'workplace_decode' | 'dating_decode'
export type ContextType = 'dating' | 'work' | 'friendship' | 'family' | 'social' | 'other'
export type AnalysisStatus = 'pending_payment' | 'paid' | 'intake_pending' | 'generating' | 'completed' | 'failed' | 'blocked'

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_PRICE_QUICK: string
  STRIPE_PRICE_DEEP: string
  STRIPE_PRICE_PATTERN: string
  STRIPE_PRICE_UPSELL: string
  LLM_API_KEY: string
  LLM_MODEL: string
  LLM_BASE_URL: string
  ADMIN_USER: string
  ADMIN_PASS: string
  APP_URL: string
}

export const OFFER_PRICES: Record<OfferType, { cents: number; label: string; description: string }> = {
  quick_decode: { cents: 1900, label: '19€', description: 'Quick Decode' },
  deep_read: { cents: 2900, label: '29€', description: 'Deep Read' },
  pattern_analysis: { cents: 5900, label: '59€', description: 'Pattern Analysis' },
}

export const UPSELL_PRICE = { cents: 900, label: '9€', description: 'Reply Generator' }

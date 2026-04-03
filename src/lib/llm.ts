import { buildSystemPrompt, buildUserPrompt } from './prompts'
import type { OfferType, AnalysisMode, ContextType } from './types'

export interface LLMConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export interface AnalysisInput {
  offerType: OfferType
  mode: AnalysisMode
  contextType?: ContextType | string
  goal?: string
  inputText: string
  extraContext?: string
  timingContext?: string
  userQuestion?: string
  language?: string
}

export async function callLLM(config: LLMConfig, input: AnalysisInput): Promise<unknown> {
  const systemPrompt = buildSystemPrompt(input.offerType, input.mode)
  const userPrompt = buildUserPrompt({
    language: input.language ?? 'fr',
    offerType: input.offerType,
    mode: input.mode,
    contextType: input.contextType,
    goal: input.goal,
    inputText: input.inputText,
    extraContext: input.extraContext,
    timingContext: input.timingContext,
    userQuestion: input.userQuestion,
  })

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(45000),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM API error ${response.status}: ${err}`)
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty LLM response')

  try {
    return JSON.parse(content)
  } catch {
    throw new Error('Invalid JSON from LLM')
  }
}

export function isSafetyBlock(result: unknown): boolean {
  const r = result as Record<string, unknown>
  return r?.status === 'safety_block' || r?.safety_note !== null && r?.safety_note !== undefined && r?.status === 'blocked'
}

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const TrainRequestSchema = z.object({
  instruction: z.string().min(5).max(1000),
})

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  // Auth check using session client
  const supabaseAuth = await createClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabaseAuth
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = TrainRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { instruction } = parsed.data

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Extract memory rules from this founder instruction for an executive assistant AI.

Instruction: "${instruction}"

Return ONLY a valid JSON array, no markdown, no explanation:
[
  {
    "key": "snake_case_unique_key",
    "value": "clear instruction for the PA to follow",
    "category": "rules|preferences|identity|company|personal",
    "importance": 7
  }
]`,
      },
    ],
  })

  const rawText = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')
    .replace(/```json|```/g, '')
    .trim()

  try {
    const memories = JSON.parse(rawText)
    const supabaseAdmin = createAdminClient()
    const results = []

    for (const mem of memories) {
      if (!mem.key || !mem.value) continue
      const key = mem.key.replace(/\s+/g, '_').toLowerCase()

      const { data, error } = await supabaseAdmin
        .from('memories')
        .upsert(
          {
            key,
            value: mem.value,
            category: mem.category ?? 'rules',
            importance: mem.importance ?? 7,
            source: 'founder_training',
            is_active: true,
          },
          { onConflict: 'key' }
        )
        .select()
        .single()

      if (!error && data) results.push(data)
    }

    return NextResponse.json({ success: true, memories: results })
  } catch (e) {
    console.error('Train parse error:', e, '\nRaw:', rawText)
    return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
  }
}

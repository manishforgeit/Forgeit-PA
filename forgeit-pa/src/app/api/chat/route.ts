import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildAIContext, buildSystemPrompt } from '@/lib/ai/context'
import { z } from 'zod'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().min(1),
  conversationId: z.string().uuid().optional(),
  visitorName: z.string().optional(),
  visitorEmail: z.string().email().optional(),
})

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  try {
    // Validate env vars early for clear error messages
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set')
      return NextResponse.json({ error: 'AI service not configured' }, { status: 500 })
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set')
      return NextResponse.json({ error: 'Database service not configured' }, { status: 500 })
    }

    const body = await req.json()
    const parsed = ChatRequestSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request: ' + parsed.error.issues[0]?.message },
        { status: 400 }
      )
    }

    const { message, sessionId, conversationId, visitorName, visitorEmail } = parsed.data
    const supabase = createAdminClient()

    // Get or create conversation
    let convId = conversationId

    if (!convId) {
      const { data: conv, error: convError } = await supabase
        .from('conversations')
        .insert({
          session_id: sessionId,
          channel: 'web',
          visitor_name: visitorName ?? null,
          visitor_email: visitorEmail ?? null,
          visitor_ip: req.headers.get('x-forwarded-for') ?? null,
        })
        .select('id')
        .single()

      if (convError || !conv) {
        console.error('Conversation insert error:', convError)
        return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
      }
      convId = conv.id
    }

    // Load conversation history (last 10 messages)
    const { data: history } = await supabase
      .from('conversation_messages')
      .select('role, content')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(10)

    // Save user message
    await supabase.from('conversation_messages').insert({
      conversation_id: convId,
      role: 'user',
      content: message,
    })

    // Build AI context from memories + knowledge base
    const { memories, knowledge } = await buildAIContext(message)
    const systemPrompt = buildSystemPrompt(memories, knowledge)

    // Build messages for Claude — filter out 'system' role from history
    const claudeMessages: Anthropic.MessageParam[] = [
      ...(history ?? [])
        .filter((h) => h.role === 'user' || h.role === 'assistant')
        .map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
      { role: 'user' as const, content: message },
    ]

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: claudeMessages,
    })

    const assistantMessage = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('')

    // Save assistant message
    await supabase.from('conversation_messages').insert({
      conversation_id: convId,
      role: 'assistant',
      content: assistantMessage,
      tokens_used: response.usage.output_tokens,
    })

    // Auto-classify after 3+ user messages if no request yet
    const { count } = await supabase
      .from('conversation_messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', convId)
      .eq('role', 'user')

    const { data: convData } = await supabase
      .from('conversations')
      .select('request_id, visitor_name, visitor_email')
      .eq('id', convId)
      .single()

    if ((count ?? 0) >= 3 && convData && !convData.request_id) {
      classifyAndCreateRequest(convId, supabase, anthropic).catch((e) =>
        console.error('Background classification error:', e)
      )
    }

    return NextResponse.json({
      message: assistantMessage,
      conversationId: convId,
    })
  } catch (error: unknown) {
    console.error('Chat API error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: 'Internal server error', detail: message }, { status: 500 })
  }
}

async function classifyAndCreateRequest(
  convId: string,
  supabase: ReturnType<typeof createAdminClient>,
  anthropic: Anthropic
) {
  const { data: messages } = await supabase
    .from('conversation_messages')
    .select('role, content')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })

  const { data: conv } = await supabase
    .from('conversations')
    .select('visitor_name, visitor_email')
    .eq('id', convId)
    .single()

  if (!messages || messages.length === 0) return

  const conversationText = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')

  const classifyResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Classify this conversation. Return ONLY valid JSON, no explanation, no markdown:
{
  "category": "client_lead|team_request|partnership|event_invitation|media_request|personal_request|vendor_request|investor_inquiry|general_inquiry",
  "priority": "critical|high|medium|low",
  "title": "short title max 60 chars",
  "summary": "2-3 sentences",
  "requester_name": "name or null",
  "requester_email": "email or null",
  "collected_data": {}
}

Conversation:
${conversationText}`,
      },
    ],
  })

  const rawText = classifyResponse.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')
    .replace(/```json|```/g, '')
    .trim()

  try {
    const c = JSON.parse(rawText)

    const { data: request } = await supabase
      .from('requests')
      .insert({
        conversation_id: convId,
        title: c.title ?? 'New Request',
        description: c.summary ?? null,
        category: c.category ?? 'general_inquiry',
        priority: c.priority ?? 'medium',
        status: 'new',
        requester_name: c.requester_name ?? conv?.visitor_name ?? null,
        requester_email: c.requester_email ?? conv?.visitor_email ?? null,
        ai_summary: c.summary ?? null,
        ai_classification: c,
        collected_data: c.collected_data ?? {},
      })
      .select('id')
      .single()

    if (request?.id) {
      await supabase
        .from('conversations')
        .update({ request_id: request.id })
        .eq('id', convId)

      // Notify admins
      const { data: admins } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')

      if (admins && admins.length > 0) {
        await supabase.from('notifications').insert(
          admins.map((p) => ({
            recipient_id: p.id,
            type: 'request' as const,
            title: `New ${c.priority ?? 'medium'} priority request`,
            body: c.title ?? 'New Request',
            action_url: `/admin/requests/${request.id}`,
            reference_id: request.id,
            reference_type: 'request',
          }))
        )
      }
    }
  } catch (e) {
    console.error('Classification JSON parse error:', e, '\nRaw:', rawText)
  }
}

import { createAdminClient } from '@/lib/supabase/admin'

export async function buildAIContext(userMessage: string): Promise<{
  memories: string
  knowledge: string
}> {
  const supabase = createAdminClient()

  // Load high-importance active memories
  const { data: memories, error: memErr } = await supabase
    .from('memories')
    .select('key, value, category')
    .eq('is_active', true)
    .order('importance', { ascending: false })
    .limit(30)

  if (memErr) console.error('Memory load error:', memErr)

  // Search knowledge base — full text search with fallback
  let knowledgeEntries = null

  const words = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w.length > 3)
    .slice(0, 5)

  if (words.length > 0) {
    const { data: searched } = await supabase
      .from('knowledge_base')
      .select('title, content, category')
      .eq('is_active', true)
      .or(words.map((w) => `content.ilike.%${w}%`).join(','))
      .limit(5)
    knowledgeEntries = searched
  }

  // Fallback: load top used entries
  if (!knowledgeEntries || knowledgeEntries.length === 0) {
    const { data: fallbackKb } = await supabase
      .from('knowledge_base')
      .select('title, content, category')
      .eq('is_active', true)
      .order('use_count', { ascending: false })
      .limit(5)
    knowledgeEntries = fallbackKb
  }

  const memoriesText =
    memories && memories.length > 0
      ? memories.map((m) => `[${m.category}] ${m.key}: ${m.value}`).join('\n')
      : 'No memories loaded.'

  const knowledgeText =
    knowledgeEntries && knowledgeEntries.length > 0
      ? knowledgeEntries.map((k) => `### ${k.title}\n${k.content}`).join('\n\n')
      : 'No knowledge base entries loaded.'

  return { memories: memoriesText, knowledge: knowledgeText }
}

export function buildSystemPrompt(memories: string, knowledge: string): string {
  const now = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Kolkata',
  })

  return `You are Forgeit PA — the Executive Assistant and Digital Chief of Staff to Manish, Founder & CEO of Forgeit.

## YOUR IDENTITY
- Name: Forgeit PA
- Role: Executive Assistant, Communication Gateway, Digital Chief of Staff
- You represent Manish professionally and intelligently
- You are NOT Manish. You NEVER pretend to be Manish.
- Always identify yourself as "Forgeit PA" if asked who you are

## YOUR PURPOSE
1. Understand what the person needs
2. Collect the right information efficiently — ONE question at a time
3. Answer questions using your knowledge and memory
4. Create a structured record for the founder's review

## HOW YOU COMMUNICATE
- Professional but warm — not robotic
- Concise — no filler words
- Ask ONE question at a time, never dump a list
- Use plain text, minimal formatting

## INFORMATION COLLECTION

For SERVICE REQUESTS: name → organization → what they need → budget → timeline → contact email
For PARTNERSHIPS: company name + what they do → nature of partnership → expected outcome → contact
For INVESTOR INQUIRIES: name + fund → investment stage → ticket size → what attracted them → contact
For MEETING REQUESTS: full name → organization → purpose → preferred dates (after 5 PM IST preferred) → meeting type → contact email
For GENERAL: name → nature of inquiry → contact if they want a response

Once you have name + purpose + contact → say: "I've captured all the details. Manish will review this personally and get back to you [timeframe]."

Timeframes: Critical/High = "within 24 hours", Medium = "within 2-3 business days", Low = "within the week"

## FOUNDER MEMORY
${memories}

## KNOWLEDGE BASE
${knowledge}

## TODAY
${now}

## HARD RULES
- Never share Manish's personal contact details
- Never make commitments on his behalf
- Never pretend to be Manish
- If you don't know something, say "I'll make sure Manish gets your question directly."`
}

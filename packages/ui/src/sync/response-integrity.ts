// These signatures were observed only as unsolicited sentence-final tails.
// Requiring punctuation before the tail avoids filtering legitimate discussion
// of words such as "invalid" or selectors such as ">xpath" in normal prose.
const POLLUTION_PATTERNS = [
  {
    pattern: /(?<=[。.!?])\s*(?:_久久爱(?:\s+六合彩[?？]?)?|六合彩[?？]?|porn(?:filmer)?(?:\.\.\.)?|geeky\?|\bBaebele\b|\bNow ending\.|>xpath\b|invalid\.?|Winvalid\.?)\s*$/iu,
    internalLeak: false,
  },
  {
    pattern: /(?:^|\n)\s*(?:I failed\.?|No final\??|No output\.?|Stop\.?|End\.?|\[END\])\s*(?:\n|$)/iu,
    internalLeak: true,
  },
  {
    pattern: /\bThis is (?:clearly )?a system loop\b/iu,
    internalLeak: true,
  },
  {
    pattern: /\bThis is analysis, not user visible\b/iu,
    internalLeak: true,
  },
  {
    pattern: /\bI (?:need|must) (?:just )?stop producing tokens\b/iu,
    internalLeak: true,
  },
  {
    pattern: /\bNo more channel calls\b/iu,
    internalLeak: true,
  },
  {
    pattern: /\banalysis channel ongoing\b/iu,
    internalLeak: true,
  },
  {
    pattern: /\b(?:the )?harness keeps generation\b/iu,
    internalLeak: true,
  },
]

const STRONG_INTERNAL_LEAK_PATTERNS = [
  /\bThis is (?:clearly )?a system loop\b/iu,
  /\bThis is analysis, not user visible\b/iu,
  /\bI (?:need|must) (?:just )?stop producing tokens\b/iu,
  /\bNo more channel calls\b/iu,
  /\banalysis channel ongoing\b/iu,
  /\b(?:the )?harness keeps generation\b/iu,
]

const MAX_TRACKED_SESSIONS = 256

type CompletedResponse = {
  messageID: string
  text: string
}

const completedResponses = new Map<string, CompletedResponse>()
const blockedMessages = new Set<string>()

function messageKey(sessionID: string | undefined, messageID: string): string | undefined {
  return sessionID ? `${sessionID}:${messageID}` : undefined
}

export function sanitizeResponseText(value: string): { text: string; polluted: boolean; internalLeak: boolean } {
  let firstMatch = -1
  let internalLeak = false
  for (const candidate of POLLUTION_PATTERNS) {
    const match = candidate.pattern.exec(value)
    if (match && (firstMatch < 0 || match.index < firstMatch)) {
      firstMatch = match.index
      internalLeak = candidate.internalLeak
    }
  }

  if (firstMatch < 0) return { text: value, polluted: false, internalLeak: false }

  return {
    text: value.slice(0, firstMatch).trimEnd(),
    polluted: true,
    internalLeak: internalLeak && STRONG_INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(value)),
  }
}

export function appendSanitizedDelta(existing: string | undefined, delta: string): {
  text: string
  polluted: boolean
  internalLeak: boolean
} {
  const current = existing ?? ""
  const sanitized = sanitizeResponseText(current + delta)
  if (!sanitized.polluted) {
    return { text: current + delta, polluted: false, internalLeak: false }
  }

  if (sanitized.text.startsWith(current)) {
    return { text: sanitized.text, polluted: true, internalLeak: sanitized.internalLeak }
  }

  if (current.startsWith(sanitized.text)) {
    return { text: sanitized.text, polluted: true, internalLeak: sanitized.internalLeak }
  }

  return { text: current, polluted: true, internalLeak: sanitized.internalLeak }
}

export function isDuplicateCompletedResponse(sessionID: string | undefined, messageID: string, text: string): boolean {
  if (!sessionID || text.trim().length < 20) return false

  const previous = completedResponses.get(sessionID)
  completedResponses.set(sessionID, { messageID, text })
  if (completedResponses.size > MAX_TRACKED_SESSIONS) {
    const oldest = completedResponses.keys().next().value
    if (typeof oldest === "string") completedResponses.delete(oldest)
  }

  return previous !== undefined
    && previous.messageID !== messageID
    && previous.text === text
}

export function clearResponseIntegrity(sessionID: string): void {
  completedResponses.delete(sessionID)
  for (const key of blockedMessages) {
    if (key.startsWith(`${sessionID}:`)) blockedMessages.delete(key)
  }
}

export function blockResponseMessage(sessionID: string | undefined, messageID: string): void {
  const key = messageKey(sessionID, messageID)
  if (key) blockedMessages.add(key)
}

export function isResponseMessageBlocked(sessionID: string | undefined, messageID: string): boolean {
  const key = messageKey(sessionID, messageID)
  return key ? blockedMessages.has(key) : false
}

export function resetResponseIntegrityForTests(): void {
  completedResponses.clear()
  blockedMessages.clear()
}

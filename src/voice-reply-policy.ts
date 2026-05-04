const MAX_VOICE_REPLY_CHARS = 1200;
const STRUCTURED_LINE_THRESHOLD = 4;

const TEXT_ORIENTED_TRANSCRIPT_PATTERNS = [
  /\b(?:search|browse|look\s+up|google|research|find)\b.*\b(?:web|internet|online)\b/i,
  /\b(?:web|internet|online)\b.*\b(?:search|browse|look\s+up|research|find)\b/i,
  /\b(?:latest|recent|current|today'?s?|this\s+(?:morning|afternoon|evening|week|month|year))\b/i,
  /\bnews\b/i,
  /\b(?:source|sources|citation|citations|cite|link|links|url|urls|article|articles)\b/i,
  /\b(?:list|bullet(?:\s+point)?s?|table|compare|comparison)\b/i,
  /\b(?:code|command|commands|terminal|shell|script|snippet|diff|patch|error|stack\s+trace)\b/i,
  /\b(?:send|give|reply|respond)\s+(?:it\s+)?(?:back\s+)?(?:as\s+)?text\b/i,
  /\btext\s+(?:me|reply|response|answer)\b/i,
  /\bwrite\s+(?:it|this|that|the answer|the response)\b/i,
];

export function shouldReplyToVoiceTranscriptWithVoice(transcript: string): boolean {
  const normalizedTranscript = normalizeForPolicy(transcript);
  if (!normalizedTranscript) {
    return false;
  }

  return !TEXT_ORIENTED_TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(normalizedTranscript));
}

export function shouldSynthesizeReplyAsVoice(text: string): boolean {
  const normalizedText = normalizeForPolicy(text);
  if (!normalizedText || normalizedText.length > MAX_VOICE_REPLY_CHARS) {
    return false;
  }

  if (containsLink(normalizedText) || containsCodeFence(normalizedText) || containsTable(normalizedText)) {
    return false;
  }

  return countStructuredLines(text) < STRUCTURED_LINE_THRESHOLD;
}

function normalizeForPolicy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsLink(value: string): boolean {
  return /\b(?:https?:\/\/|www\.)\S+/i.test(value);
}

function containsCodeFence(value: string): boolean {
  return /```/.test(value);
}

function containsTable(value: string): boolean {
  return /\|[^\n]+\|/.test(value);
}

function countStructuredLines(value: string): number {
  return value
    .split("\n")
    .filter((line) => /^(?:\s*[-*]\s+|\s*\d+[.)]\s+|\s*>|\s{2,}\S)/.test(line)).length;
}

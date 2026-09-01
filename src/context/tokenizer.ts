/**
 * Lightweight token estimator. Avoids a heavyweight tokenizer dependency while
 * staying close enough for budgeting decisions: it blends word count and
 * character count, which tracks BPE token counts well for source code.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  // BPE tends to sit between word count and chars/4; average the two signals.
  return Math.ceil((words * 1.3 + chars / 4) / 2);
}

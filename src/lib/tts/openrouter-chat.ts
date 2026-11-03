/**
 * Shared helpers for talking to the OpenRouter chat endpoint.
 *
 * Four modules build the same URL and unwrap the same fenced-JSON reply
 * (`listen-prep`, `chapter-ai`, `chapter-choice`, `topic-llm`). Keeping one
 * copy means a base-URL or fence-handling fix lands everywhere at once.
 */

/** `…/chat/completions`, from `OPENROUTER_BASE_URL` or the public default. */
export function openRouterChatUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  );
  return `${base}/chat/completions`;
}

/**
 * Parse a model reply that may be wrapped in a ```json fence or in prose.
 * Takes the first `{` through the last `}`, then `JSON.parse`. Throws on a
 * reply that holds no JSON object — callers treat that as a failed call.
 */
export function unwrapJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

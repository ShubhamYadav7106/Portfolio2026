// Both modes use the same model and streaming options. Recruiter responses
// additionally need JSON for server-side grounding; General stays plain text.
export function providerRequest({ model, messages, maxTokens, json = false }) {
  return {
    model, messages, stream: true,
    max_completion_tokens: maxTokens,
    ...(json ? { temperature: 0, response_format: { type: 'json_object' } } : {}),
    ...(model.startsWith('openai/gpt-oss-') ? { include_reasoning: false, reasoning_effort: 'low' } : {}),
  }
}

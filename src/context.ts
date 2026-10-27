import { ChatMessage } from './llm';

// Keep the conversation under budget by blanking the oldest tool outputs first,
// then dropping the oldest turns. The system prompt and latest user message stay.
export function conversationSize(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? '').length, 0);
}

export function trimContext(messages: ChatMessage[], maxChars: number) {
  const size = () => conversationSize(messages);
  if (size() <= maxChars) return;

  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  for (let i = 1; i < messages.length && size() > maxChars; i++) {
    const m = messages[i];
    if (m.role === 'tool' && i < lastUser && (m.content?.length ?? 0) > 200) {
      m.content = '[old tool output removed to save space; re-run the tool if you need it]';
    }
  }
  for (let i = 1; i < messages.length && size() > maxChars; i++) {
    const m = messages[i];
    if (m.role === 'tool' && (m.content?.length ?? 0) > 2000) {
      m.content = m.content!.slice(0, 1000) + '\n...[trimmed]...\n' + m.content!.slice(-1000);
    }
  }
  // Drop whole early turns (user message through the following assistant/tool messages).
  while (size() > maxChars) {
    const firstUser = messages.findIndex((m, i) => i > 0 && m.role === 'user');
    const nextUser = messages.findIndex((m, i) => i > firstUser && m.role === 'user');
    if (firstUser < 0 || nextUser < 0) break;
    messages.splice(firstUser, nextUser - firstUser);
  }
}

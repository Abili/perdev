// Chats saved on disk. A chat can branch from a parent: the child starts fresh
// but carries the parent's handoff summary, and links back to it.

import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatMessage } from './llm';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  parentTitle?: string;
  // Handoff summary carried over from the parent (already in the system prompt).
  carriedSummary?: string;
  messages: ChatMessage[];
}

export function newSessionId(): string {
  return `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Title from the first real user message, without the editor context we append.
export function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  const clean = first.replace(/\n\n\[Context:[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? clean.slice(0, 57) + '...' : clean || 'New chat';
}

export class SessionStore {
  constructor(private readonly dir: () => string) {}

  private file(id: string) {
    return path.join(this.dir(), 'chats', `${id}.json`);
  }

  async save(s: ChatSession) {
    await fs.mkdir(path.dirname(this.file(s.id)), { recursive: true });
    s.updatedAt = new Date().toISOString();
    await fs.writeFile(this.file(s.id), JSON.stringify(s), 'utf8');
  }

  async load(id: string): Promise<ChatSession | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async list(): Promise<Omit<ChatSession, 'messages'>[]> {
    const dir = path.join(this.dir(), 'chats');
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Omit<ChatSession, 'messages'>[] = [];
    for (const n of names) {
      try {
        const { messages: _m, ...meta } = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as ChatSession;
        out.push(meta);
      } catch {
        // skip unreadable files
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

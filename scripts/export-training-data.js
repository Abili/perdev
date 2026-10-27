// Turns PerDev's logs into fine-tuning datasets.
// Usage: node scripts/export-training-data.js [dataDir] [outDir]
//
//   chat.jsonl  {"messages": [...]}  from agent sessions that finished cleanly
//               (OpenAI/ShareGPT-style; load with Unsloth/TRL SFTTrainer)
//   fim.jsonl   {"text": "<|fim_prefix|>...<|fim_middle|>completion<|endoftext|>"}
//               from completions you accepted with Tab (for the autocomplete model)
//
// Review the output before training: it contains your code.

const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.argv[2] || 'data');
const outDir = path.resolve(process.argv[3] || path.join(dataDir, 'export'));
fs.mkdirSync(outDir, { recursive: true });

function readJsonl(file) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Agent sessions: keep successful ones, drop the per-machine system prompt details
// and any turns whose tool output was trimmed (the model never saw the real data).
let chat = 0;
const chatOut = fs.createWriteStream(path.join(outDir, 'chat.jsonl'));
for (const s of readJsonl('sessions.jsonl')) {
  if (s.outcome !== 'done' || !Array.isArray(s.messages)) continue;
  const msgs = s.messages.filter((m) => !(m.role === 'tool' && /^\[old tool output removed/.test(m.content || '')));
  if (!msgs.some((m) => m.role === 'assistant')) continue;
  chatOut.write(JSON.stringify({ messages: msgs }) + '\n');
  chat++;
}
chatOut.end();

// Accepted completions become FIM examples (Qwen2.5-Coder format).
let fim = 0;
const fimOut = fs.createWriteStream(path.join(outDir, 'fim.jsonl'));
const seen = new Set();
for (const c of readJsonl('completions.jsonl')) {
  if (!c.accepted || !c.completion) continue;
  const text = `<|fim_prefix|>${c.prefix}<|fim_suffix|>${c.suffix}<|fim_middle|>${c.completion}<|endoftext|>`;
  if (seen.has(text)) continue;
  seen.add(text);
  fimOut.write(JSON.stringify({ text }) + '\n');
  fim++;
}
fimOut.end();

const rejected = readJsonl('completions.jsonl').filter((c) => !c.accepted).length;
console.log(`Exported ${chat} agent sessions -> ${path.join(outDir, 'chat.jsonl')}`);
console.log(`Exported ${fim} accepted completions -> ${path.join(outDir, 'fim.jsonl')} (${rejected} rejected, kept in logs for later preference training)`);

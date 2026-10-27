// Fill-in-the-middle prompt formats and output cleanup. No VS Code dependency.

export interface FimFormat {
  match: RegExp;
  build: (prefix: string, suffix: string) => string;
  stop: string[];
}

// FIM prompt formats for common open coding models, picked by model name.
export const FIM_FORMATS: FimFormat[] = [
  {
    match: /qwen/i,
    build: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
    stop: ['<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '<|fim_prefix|>', '<|im_end|>'],
  },
  {
    match: /deepseek/i,
    build: (p, s) => `<｜fim▁begin｜>${p}<｜fim▁hole｜>${s}<｜fim▁end｜>`,
    stop: ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>'],
  },
  {
    match: /codestral|mistral/i,
    build: (p, s) => `[SUFFIX]${s}[PREFIX]${p}`,
    stop: ['[PREFIX]', '[SUFFIX]', '</s>'],
  },
  {
    // StarCoder family and a reasonable default
    match: /.*/,
    build: (p, s) => `<fim_prefix>${p}<fim_suffix>${s}<fim_middle>`,
    stop: ['<|endoftext|>', '<fim_prefix>', '<file_sep>'],
  },
];

export function fimFormatFor(model: string): FimFormat {
  return FIM_FORMATS.find((f) => f.match.test(model))!;
}

// Trim completions that just repeat text already after the cursor.
export function cleanCompletion(text: string, suffix: string): string {
  let out = text.replace(/\r\n/g, '\n');
  const nextLine = suffix.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (nextLine) {
    const lines = out.split('\n');
    const dup = lines.findIndex((l, i) => i > 0 && l.trim() === nextLine);
    if (dup > 0) out = lines.slice(0, dup).join('\n');
  }
  return out.replace(/\s+$/, '');
}

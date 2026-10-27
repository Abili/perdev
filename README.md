# PerDev

A local-first AI coding agent for VS Code that runs on **your own model**, for free.

- **Agent chat** (sidebar): reads, searches and edits files and runs commands to finish real tasks.
- **Tab autocomplete**: fill-in-the-middle ghost text from a small, fast local model.
- **Training-data logging**: every agent session and every accepted or rejected completion is saved as JSONL, ready for fine-tuning your own model later. Nothing leaves your machine.
- **Any OpenAI-compatible server**: Ollama by default; vLLM, llama.cpp, LM Studio or a hosted API work by changing one setting.

## Setup (all on E:)

1. **Ollama** is installed at `E:\Tools\Ollama`, with models stored in `E:\Tools\ollama-models` (the `OLLAMA_MODELS` user environment variable).
2. **Models**, from this folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-models.ps1
   ```
   This pulls `qwen2.5-coder:7b` (agent) and `qwen2.5-coder:1.5b-base` (autocomplete), then builds `perdev-coder` from [models/Modelfile](models/Modelfile) with a 16k context window.
3. **Run the extension**: open this folder in VS Code and press **F5**. A second VS Code window opens on `playground/` with PerDev loaded. Click the `</>` icon in the activity bar.

Try: *"run the tests and fix anything that fails"* in the playground.

## Development

```powershell
npm install      # npm cache lives on E: (see .npmrc)
npm run compile
npm test         # unit tests, no VS Code needed
```

| File | What it does |
|---|---|
| [src/llm.ts](src/llm.ts) | OpenAI-compatible streaming client with tool calls, plus a fallback parser for models that write tool calls as text |
| [src/agent.ts](src/agent.ts) | The agent loop and system prompt |
| [src/tools.ts](src/tools.ts) | read_file, write_file, edit_file, list_files, search, run_command |
| [src/context.ts](src/context.ts) | Keeps the conversation inside the model's context window |
| [src/chatView.ts](src/chatView.ts) | Sidebar chat UI |
| [src/autocomplete.ts](src/autocomplete.ts), [src/fim.ts](src/fim.ts) | Inline completions and FIM prompt formats |
| [src/logger.ts](src/logger.ts) | JSONL training-data logs |

## Settings

| Setting | Default | |
|---|---|---|
| `perdev.baseUrl` | `http://localhost:11434/v1` | Any OpenAI-compatible endpoint |
| `perdev.chatModel` | `perdev-coder` | |
| `perdev.autocomplete.model` | `qwen2.5-coder:1.5b-base` | Must be a *base* model with FIM support |
| `perdev.agent.approveCommands` | `true` | Ask before running shell commands |
| `perdev.agent.approveEdits` | `false` | Ask before writing files |
| `perdev.dataDir` | extension storage | Where training logs go. The playground sets it to `E:\codingprojects\PerDev\data` |

## Roadmap

1. **Now:** use PerDev daily so it collects sessions and completion feedback in `data/`.
2. **Fine-tune for free:** train a LoRA on `data/*.jsonl` with Unsloth on Kaggle or Colab free GPUs, export to GGUF, and point `models/Modelfile` at it. Then `perdev-coder` really is your model.
3. **Evals:** a fixed set of tasks (like the playground) to measure each new model version.
4. **Later:** fork VSCodium when the extension API becomes the limit, then a hosted tier for people without GPUs.

Base models are Apache-2.0 licensed (Qwen2.5-Coder 1.5B and 7B), so commercial use is allowed.

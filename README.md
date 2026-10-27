# PerDev

A local-first AI coding agent for VS Code that runs on **your own model**, for free.

- **Agent chat** (sidebar): reads, searches and edits files and runs commands to finish real tasks.
- **Tab autocomplete**: fill-in-the-middle ghost text from a small, fast local model.
- **Training-data logging**: every agent session and every accepted or rejected completion is saved as JSONL, ready for fine-tuning your own model later. Nothing leaves your machine.
- **Any OpenAI-compatible server**: llama.cpp by default (started automatically); Ollama, vLLM, LM Studio or a hosted API work by changing settings.

## Setup (all on E:)

1. **llama.cpp** (Vulkan build, runs on the RTX 3070) is at `E:\Tools\llamacpp`. It was copied from Android Studio's bundled copy, so nothing extra had to be downloaded.
2. **Models** go in `E:\Tools\models`. Run `scripts\download-models.cmd`; it resumes if the connection drops.
   - `Qwen2.5-Coder-1.5B.Q4_K_M.gguf` (0.94 GB): autocomplete
   - `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` (4.4 GB): chat and agent
3. **Run the extension**: open this folder in VS Code and press **F5**. A second VS Code window opens on `playground/` with PerDev loaded, and PerDev starts both model servers itself (see the "PerDev Servers" output). Click the PerDev logo in the activity bar.

To run the servers without VS Code, use `scripts\start-servers.cmd`. To test the agent from a terminal: `node scripts/e2e-agent.js playground "run the tests and fix what fails"`.

Try: *"run the tests and fix anything that fails"* in the playground.

## Development

```powershell
npm install      # npm cache lives on E: (see .npmrc)
                 # git: E: doesn't record file owners; use  git -c safe.directory=E:/codingprojects/PerDev ...
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
| `perdev.baseUrl` | `http://127.0.0.1:8080/v1` | Any OpenAI-compatible endpoint |
| `perdev.server.chatModelPath` | 7B GGUF on E: | Swap in your own fine-tuned GGUF here |
| `perdev.server.device` | `Vulkan1` | The RTX 3070 (`llama-server --list-devices`) |
| `perdev.autocomplete.url` | `http://127.0.0.1:8081` | llama.cpp autocomplete server |
| `perdev.agent.approveCommands` | `true` | Ask before running shell commands |
| `perdev.agent.approveEdits` | `false` | Ask before writing files |
| `perdev.dataDir` | extension storage | Where training logs go. The playground sets it to `E:\codingprojects\PerDev\data` |

## Roadmap

1. **Now:** use PerDev daily so it collects sessions and completion feedback in `data/`.
2. **Fine-tune for free:** run `node scripts/export-training-data.js data` to build `chat.jsonl` and `fim.jsonl`. Train a LoRA with Unsloth on Kaggle or Colab free GPUs, export to GGUF, and point `perdev.server.chatModelPath` at it. Then PerDev really runs on your model.
3. **Evals:** a fixed set of tasks (like the playground) to measure each new model version.
4. **Later:** fork VSCodium when the extension API becomes the limit, then a hosted tier for people without GPUs.

Base models are Apache-2.0 licensed (Qwen2.5-Coder 1.5B and 7B), so commercial use is allowed. Avoid the 3B size, which has a non-commercial license.

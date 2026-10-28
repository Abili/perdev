# PerDev

A free, local-first AI code editor that runs on **your own model**. PerDev is its own app, built on the open-source VS Code core (via VSCodium: no telemetry, Open VSX extensions), with its AI built in.

- **Start screen**: PerDev opens to "What are you building today?" with project cards for Mobile (React Native, Flutter, Android, iOS), Web (static site, React, Next.js) and Backend & scripts (Node API, FastAPI, Python). Each card checks whether its tools are installed. Creating a project runs the official generator in a visible terminal (or writes a small offline starter) and hands your description to the agent.
- **Android device tools**: with [DroidLoop](https://github.com/Abili) (or any MCP server) listed in `perdev.mcpServers`, the agent can build, install, launch and drive Android apps on a phone or emulator, reading the screen as text after every action.
- **Agent chat** (sidebar): reads, searches and edits files and runs commands to finish real tasks.
- **Official docs lookup**: the agent can look things up in the official documentation of ~800 languages and libraries (Python, JavaScript/MDN, TypeScript, Node.js, React, Rust, Go, Django, NumPy...) through [DevDocs](https://devdocs.io). Only a small search index (once per doc set) and single pages are downloaded, and both are cached, so it stays usable on a slow connection. Turn it off with `perdev.docs.enabled`.
- **Tab autocomplete**: fill-in-the-middle ghost text from a small, fast local model.
- **Branching chats**: a context meter shows how full the chat is. When it gets long, PerDev offers to *continue in a new chat*: the model writes a handoff note (goal, what's done, key facts, next steps), and the new chat starts with it and links back to the parent. Chats are saved, and you can reopen any of them (history button).
- **Training-data logging**: every agent session and every accepted or rejected completion is saved as JSONL, ready for fine-tuning your own model later. Nothing leaves your machine.
- **Any OpenAI-compatible server**: llama.cpp by default (started automatically); Ollama, vLLM, LM Studio or a hosted API work by changing settings.

## The PerDev app

There are two ways to get the app:

- **Built from source in the cloud (the real fork):** [.github/workflows/build-windows.yml](.github/workflows/build-windows.yml) compiles VS Code from source on GitHub's free Windows runners with VSCodium's build scripts, PerDev's branding ([scripts/brand-fork.js](scripts/brand-fork.js)) and the built-in AI. Run it from the repo's *Actions* tab and download the installer from the run's artifacts.
- **Quick local build:** [scripts/build-app.js](scripts/build-app.js) turns a VSCodium release zip into `D:\PerDev\PerDev.exe` (rebranded, updater removed, AI built in, portable: all data stays in `D:\PerDev\data`). Run `npm run app` (close PerDev first).

> **Keep PerDev and its models on an SSD.** From the USB hard disk (E:) the editor took minutes to start and the AI never finished loading; from the NVMe SSD (D:) it starts in seconds.

Both use the same branding code ([scripts/branding.js](scripts/branding.js)).

## Local AI setup (all on E:)

1. **llama.cpp** (Vulkan build, runs on the RTX 3070) is at `D:\PerDev-AI\llamacpp`. It was copied from Android Studio's bundled copy, so nothing extra had to be downloaded.
2. **Models** go in `D:\PerDev-AI\models`. Run `scripts\download-models.cmd`; it resumes if the connection drops and only names a file when it's complete.
   - `Qwen2.5-Coder-1.5B.Q4_K_M.gguf` (0.94 GB): autocomplete
   - `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` (4.4 GB): chat and agent
3. Open PerDev. It starts both model servers itself on ports 8780/8781 (see the *PerDev Servers* output). The first time you open a folder, choose **Trust**; the agent needs it to run commands.

Try: *"run the tests and fix anything that fails"* in `playground/`.

**How well the base 7B model works as an agent (measured):** it reliably runs tests, reads the right files and summarizes correctly. The "make the fix" step is the weak spot, right roughly 60–75% of the time in local tests. PerDev guards against its common mistakes (copying `read_file` line numbers into edits, describing a fix instead of making it). Fine-tuning ([Training your model](#training-your-model)) is how to improve it.

For extension development, open this folder in VS Code/PerDev and press **F5**. To run the servers by hand: `scripts\start-servers.cmd`.

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
| `perdev.baseUrl` | `http://127.0.0.1:8780/v1` | Any OpenAI-compatible endpoint |
| `perdev.server.chatModelPath` | 7B GGUF on E: | Swap in your own fine-tuned GGUF here |
| `perdev.server.device` | `Vulkan1` | The RTX 3070 (`llama-server --list-devices`) |
| `perdev.autocomplete.url` | `http://127.0.0.1:8781` | llama.cpp autocomplete server |
| `perdev.agent.approveCommands` | `true` | Ask before running shell commands |
| `perdev.agent.approveEdits` | `false` | Ask before writing files |
| `perdev.dataDir` | extension storage | Where training logs go. The playground sets it to `E:\codingprojects\PerDev\data` |

## Training your model

[training/perdev_finetune.ipynb](training/perdev_finetune.ipynb) fine-tunes Qwen2.5-Coder-7B into PerDev's agent on a **free Kaggle GPU**. All the big downloads happen in Kaggle's datacenter; you only download the finished adapter (about 80 MB).

- **Data:** [SWE-smith trajectories](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories) (MIT). These are thousands of real bug-fix sessions, each verified by the project's tests. [training/build_dataset.py](training/build_dataset.py) rewrites them into PerDev's exact tools, system prompt and output format, so the model learns *this* agent's interface. Your own PerDev chats (`chat.jsonl` from `scripts/export-training-data.js`) can be added and are weighted 3×.
- **Method:** LoRA on the 4-bit model with Unsloth. Only the assistant's turns are learned; tool output is masked.
- **Proof it helped:** the notebook scores the model before and after on held-out sessions (valid tool calls, same tool as the successful reference). Keep the adapter only if the score improves.
- **Use it:** put `perdev-lora-f16.gguf` in `D:\PerDev-AI\models` and set `perdev.server.chatLoraPath`.

Steps: kaggle.com → *Create → New Notebook → File → Import Notebook* → pick `training/perdev_finetune.ipynb` → *Settings*: GPU T4 x2 and Internet on → *Save Version → Save & Run All*.

If you change the tools or the system prompt, run `npm run compile && node scripts/export-format.js && python training/make_notebook.py` to regenerate the notebook, so training always matches the extension.

## Roadmap

1. **Now:** use PerDev daily so it collects sessions and completion feedback in `data/`.
2. **Fine-tune for free:** see [Training your model](#training-your-model).
3. **Evals:** a fixed set of tasks (like the playground) to measure each new model version.
4. **Later:** fork VSCodium when the extension API becomes the limit, then a hosted tier for people without GPUs.

Base models are Apache-2.0 licensed (Qwen2.5-Coder 1.5B and 7B), so commercial use is allowed. Avoid the 3B size, which has a non-commercial license.

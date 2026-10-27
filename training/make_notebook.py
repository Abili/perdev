"""Builds perdev_finetune.ipynb, a self-contained Kaggle notebook that
fine-tunes PerDev's model on free agent data and exports a LoRA adapter
llama.cpp can load. build_dataset.py and perdev_format.json are embedded so
the notebook needs nothing but internet access.

  python training/make_notebook.py
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src.strip("\n")}


def code(src):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src.strip("\n")}


def writefile(name):
    return code(f"%%writefile {name}\n" + (HERE / name).read_text(encoding="utf-8"))


cells = [
    md("""
# PerDev fine-tune: teach Qwen2.5-Coder-7B to be PerDev's agent

Trains a LoRA adapter on real, test-verified bug-fix sessions from
[SWE-smith trajectories](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories) (MIT license),
rewritten into PerDev's exact tools and system prompt. You can add your own PerDev logs as well.

**How to run on Kaggle (free):**
1. *Settings → Accelerator → GPU T4 x2* and *Settings → Internet → On* (your account needs a verified phone number for GPUs).
2. Optional: upload your `chat.jsonl` from `node scripts/export-training-data.js data` as a Kaggle dataset and add it to this notebook.
3. Click **Save Version → Save & Run All (Commit)**. It runs in the background (up to 12 h; this stops itself at `MAX_HOURS`) and you can close the tab.
4. When it finishes, open the version's **Output** tab and download `perdev-lora-f16.gguf` (about 80 MB).

The last cell prints a before/after score so you can see whether the adapter helps.
"""),
    code("""
%%capture
%pip install unsloth
"""),
    writefile("perdev_format.json"),
    writefile("build_dataset.py"),
    md("## Settings"),
    code("""
BASE_MODEL = "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit"  # 4-bit copy of Qwen/Qwen2.5-Coder-7B-Instruct
BASE_MODEL_ID = "Qwen/Qwen2.5-Coder-7B-Instruct"           # used for the GGUF adapter's metadata
MAX_SEQ = 16384     # matches PerDev's runtime context (perdev.server.chatContext)
N_TRAIN = 800       # training conversations; the time guard below stops early if needed
N_EVAL = 30         # held-out conversations for the before/after score
LORA_R = 16
LEARNING_RATE = 1e-4
MAX_HOURS = 9.0     # stop training in time to export inside Kaggle's 12 h limit
SEED = 0
"""),
    md("## 1. Build the dataset"),
    code("""
import glob, json, random
from datasets import load_dataset
import build_dataset as bd

random.seed(SEED)
raw = load_dataset("SWE-bench/SWE-smith-trajectories", split="tool")
raw = raw.filter(lambda r: r["resolved"]).shuffle(seed=SEED)

examples, skipped = [], {}
for row in raw:
    try:
        examples.append(bd.convert_row(row, max_chars=10**9))  # token length is checked later
    except bd.Skip as e:
        k = str(e).split(":")[0]
        skipped[k] = skipped.get(k, 0) + 1
    if len(examples) >= 3 * (N_TRAIN + N_EVAL):
        break
print(f"converted {len(examples)} SWE-smith conversations; skipped {skipped}")

own = []
for f in glob.glob("/kaggle/input/**/chat.jsonl", recursive=True):
    own += [json.loads(l) for l in open(f, encoding="utf-8") if l.strip()]
print(f"your own PerDev sessions: {len(own)}")
"""),
    md("## 2. Load the model and render conversations with Qwen's chat template"),
    code("""
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(BASE_MODEL, max_seq_length=MAX_SEQ, load_in_4bit=True)
TOOLS = json.load(open("perdev_format.json"))["tools"]
TOOL_NAMES = {t["function"]["name"]: t["function"]["parameters"].get("required", []) for t in TOOLS}

def to_hf(messages):
    # The chat template wants tool-call arguments as dicts, not JSON strings.
    out = []
    for m in messages:
        m = dict(m)
        if m.get("tool_calls"):
            m["tool_calls"] = [
                {"type": "function", "function": {"name": c["function"]["name"],
                 "arguments": json.loads(c["function"]["arguments"]) if isinstance(c["function"]["arguments"], str) else c["function"]["arguments"]}}
                for c in m["tool_calls"]
            ]
        if m.get("content") is None:
            m["content"] = ""
        out.append(m)
    return out

def render(messages, add_generation_prompt=False):
    return tokenizer.apply_chat_template(to_hf(messages), tools=TOOLS, tokenize=False, add_generation_prompt=add_generation_prompt)

def n_tokens(text):
    return len(tokenizer(text, add_special_tokens=False).input_ids)

fits = [e for e in examples if n_tokens(render(e["messages"])) <= MAX_SEQ]
print(f"{len(fits)} of {len(examples)} SWE-smith conversations fit in {MAX_SEQ} tokens")
random.shuffle(fits)
eval_set = fits[:N_EVAL]
train_set = fits[N_EVAL:N_EVAL + N_TRAIN] + [e for e in own if n_tokens(render(e["messages"])) <= MAX_SEQ] * 3  # upweight your own data
random.shuffle(train_set)
print(f"train: {len(train_set)}  eval: {len(eval_set)}")
"""),
    md("""
## 3. Score the base model first

For each held-out conversation, cut it just before a random assistant step and let the model produce that step.
A step counts as **valid** when it is either a well-formed call to a real PerDev tool with its required arguments,
or (when the reference step is the final answer) a plain answer with no tool call.
**Same tool** means it chose the same tool the successful reference agent used.
"""),
    code("""
import re

def score(model, eval_set, max_new_tokens=384):
    FastLanguageModel.for_inference(model)
    rng = random.Random(SEED)
    valid = same = 0
    for ex in eval_set:
        msgs = ex["messages"]
        steps = [i for i, m in enumerate(msgs) if m["role"] == "assistant" and i > 1]
        i = rng.choice(steps)
        prompt = render(msgs[:i], add_generation_prompt=True)
        ids = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).to("cuda")
        if ids.input_ids.shape[1] > MAX_SEQ - max_new_tokens:
            ids = tokenizer(render(msgs[:2], add_generation_prompt=True), return_tensors="pt", add_special_tokens=False).to("cuda")
            i = 2
        out = model.generate(**ids, max_new_tokens=max_new_tokens, do_sample=False)
        text = tokenizer.decode(out[0][ids.input_ids.shape[1]:], skip_special_tokens=False)
        calls = re.findall(r"<tool_call>\\s*(\\{.*?\\})\\s*</tool_call>", text, re.S)
        ref_calls = msgs[i].get("tool_calls") or []
        ok = False
        if not ref_calls:
            ok = not calls and "<tool_call>" not in text
        elif calls:
            try:
                c = json.loads(calls[0])
                args = c.get("arguments", {})
                ok = c.get("name") in TOOL_NAMES and all(k in args for k in TOOL_NAMES[c["name"]])
                same += ok and c["name"] == ref_calls[0]["function"]["name"]
            except json.JSONDecodeError:
                pass
        valid += ok
    n = len(eval_set)
    return {"valid_step": round(valid / n, 3), "same_tool_as_reference": round(same / n, 3)}

before = score(model, eval_set)
print("base model:", before)
"""),
    md("## 4. Train the LoRA adapter (only the assistant's turns are learned)"),
    code("""
import inspect, time
from datasets import Dataset
from transformers import TrainerCallback
from trl import SFTTrainer, SFTConfig
from unsloth.chat_templates import train_on_responses_only

model = FastLanguageModel.get_peft_model(
    model, r=LORA_R, lora_alpha=LORA_R, lora_dropout=0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=SEED,
)
FastLanguageModel.for_training(model)

class TimeGuard(TrainerCallback):
    def __init__(self, hours):
        self.deadline = time.time() + hours * 3600
    def on_step_end(self, args, state, control, **kw):
        if time.time() > self.deadline:
            print(f"Time limit reached at step {state.global_step}; stopping and keeping what was learned.")
            control.should_training_stop = True

fields = SFTConfig.__dataclass_fields__
cfg = dict(
    dataset_text_field="text", per_device_train_batch_size=1, gradient_accumulation_steps=8,
    num_train_epochs=1, learning_rate=LEARNING_RATE, warmup_ratio=0.03, lr_scheduler_type="cosine",
    logging_steps=5, optim="adamw_8bit", fp16=True, bf16=False, output_dir="outputs",
    save_strategy="no", report_to="none", seed=SEED,
)
cfg["max_length" if "max_length" in fields else "max_seq_length"] = MAX_SEQ
tok_arg = "processing_class" if "processing_class" in inspect.signature(SFTTrainer.__init__).parameters else "tokenizer"

trainer = SFTTrainer(
    model=model, train_dataset=Dataset.from_list([{"text": render(e["messages"])} for e in train_set]),
    args=SFTConfig(**cfg), callbacks=[TimeGuard(MAX_HOURS)], **{tok_arg: tokenizer},
)
# Tool results are rendered inside user turns by Qwen's template, so they are masked too.
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\\n", response_part="<|im_start|>assistant\\n")
stats = trainer.train()
print(stats)
"""),
    md("## 5. Score again"),
    code("""
after = score(model, eval_set)
print("base model:      ", before)
print("with PerDev LoRA:", after)
"""),
    md("## 6. Export the adapter for llama.cpp"),
    code("""
model.save_pretrained("perdev-lora")
tokenizer.save_pretrained("perdev-lora")
json.dump({"before": before, "after": after, "train_examples": len(train_set), "base": BASE_MODEL_ID},
          open("perdev-lora/eval.json", "w"), indent=2)

!git clone -q --depth 1 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp
!pip install -q /tmp/llama.cpp/gguf-py
!python /tmp/llama.cpp/convert_lora_to_gguf.py perdev-lora --base-model-id {BASE_MODEL_ID} --outtype f16 --outfile perdev-lora-f16.gguf
!rm -rf outputs
!ls -la /kaggle/working
"""),
    md("""
## Use it in PerDev

1. Download `perdev-lora-f16.gguf` from this version's **Output** tab and save it to `E:\\Tools\\models\\`.
2. In VS Code settings set **PerDev › Server: Chat Lora Path** to `E:\\Tools\\models\\perdev-lora-f16.gguf`.
3. Restart VS Code (or run *PerDev: Start Local Model Servers*). The chat server now loads the 7B model plus your adapter.

Only keep the adapter if `with PerDev LoRA` scores better than `base model` above.
"""),
]

nb = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
        "kaggle": {"accelerator": "nvidiaTeslaT4", "isInternetEnabled": True},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

out = HERE / "perdev_finetune.ipynb"
out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Wrote {out}")

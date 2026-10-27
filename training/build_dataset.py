"""Convert free, permissively licensed agent trajectories into PerDev's format.

Source: SWE-bench/SWE-smith-trajectories (MIT), "tool" split: real bug-fix
sessions with tool calls, each verified by the repo's tests ("resolved").

Each trajectory is rewritten so the model learns PerDev's exact interface:
  bash                            -> run_command
  str_replace_editor view (file)  -> read_file   (output in PerDev's line format)
  str_replace_editor view (dir)   -> list_files
  str_replace_editor create       -> write_file
  str_replace_editor str_replace  -> edit_file
  submit                          -> final answer (no tool call)
with PerDev's system prompt, workspace-relative paths and the same output
truncation the extension applies. Trajectories that can't be mapped cleanly
(insert/undo_edit, paths outside the repo, too long) are skipped.

Standard library only. Usage:
  python build_dataset.py --input rows.json --out train.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMAT = json.loads((HERE / "perdev_format.json").read_text(encoding="utf-8"))
MAX_OUTPUT = FORMAT["max_output"]
SRC_ROOT = "/testbed"


class Skip(Exception):
    """Trajectory can't be converted faithfully."""


def truncate(s: str) -> str:
    # Mirrors truncate() in src/toolSpecs.ts.
    if len(s) <= MAX_OUTPUT:
        return s
    half = MAX_OUTPUT // 2
    return f"{s[:half]}\n\n... [{len(s) - MAX_OUTPUT} characters truncated] ...\n\n{s[-half:]}"


def system_prompt(repo: str) -> str:
    return (
        FORMAT["system_prompt_template"]
        .replace("{root}", f"/home/dev/{repo}")
        .replace("{platform}", "linux")
        .replace("{release}", "6.8.0")
        .replace("{date}", "2025-06-01")
    )


def rel_path(p: str) -> str:
    p = p.strip()
    if p in (SRC_ROOT, SRC_ROOT + "/"):
        return "."
    if p.startswith(SRC_ROOT + "/"):
        return p[len(SRC_ROOT) + 1 :]
    if p.startswith("/"):
        raise Skip(f"path outside repo: {p}")
    return p


def rel_text(s: str) -> str:
    """Make /testbed paths in commands and outputs workspace-relative."""
    s = re.sub(r"cd /testbed\s*(&&|;)\s*", "", s)
    s = s.replace(SRC_ROOT + "/", "")
    return re.sub(r"/testbed\b", ".", s)


def text_of(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content if isinstance(part, dict))


def clean_user(text: str) -> str:
    text = re.sub(r"<uploaded_files>\s*/testbed\s*</uploaded_files>\s*", "", text)
    text = text.replace("in the directory /testbed", "in the current workspace")
    text = re.sub(r"\b(in|to|of) /testbed\b", r"\1 the workspace", text)
    return rel_text(text)


def observation(raw: str) -> str:
    raw = text_of(raw)
    return re.sub(r"^OBSERVATION:\s*\n?", "", raw)


def convert_view(args: dict, obs: str):
    path = rel_path(args["path"])
    if obs.startswith("Here's the files and directories"):
        lines = [rel_text(l.strip()) for l in obs.splitlines()[1:] if l.strip()]
        pattern = "**/*" if path == "." else f"{path}/**/*"
        return "list_files", {"pattern": pattern}, "\n".join(lines) or "No files matched."
    abbreviated = obs.startswith("<NOTE>This file is too large")
    if not abbreviated and (not obs or "cat -n" not in obs.splitlines()[0]):
        raise Skip("unexpected view output")
    out_lines = []
    for line in obs.splitlines()[1:]:
        m = re.match(r"^\s*(\d+)\t(.*)$", line)
        if m:
            out_lines.append(f"{int(m.group(1)):>5}  {m.group(2)}")
        elif abbreviated and line.strip().startswith("..."):
            out_lines.append("  ...")
    if abbreviated:
        # SWE-agent shows an outline of big files; keep it, with PerDev-style guidance.
        out_lines.append("[Large file: only an outline is shown; use offset and limit to read specific lines]")
    new_args = {"path": path}
    rng = args.get("view_range")
    if rng and len(rng) == 2:
        start, end = int(rng[0]), int(rng[1])
        new_args["offset"] = start
        if end != -1:
            new_args["limit"] = end - start + 1
    return "read_file", new_args, rel_text("\n".join(out_lines))


def convert_editor(args: dict, obs: str):
    cmd = args.get("command")
    path = rel_path(args.get("path", ""))
    if re.match(r"The path \S+ does not exist", obs) and cmd in ("view", "str_replace"):
        # Same error PerDev's read_file/edit_file return (Node's fs message).
        name = "read_file" if cmd == "view" else "edit_file"
        new_args = {"path": path} if cmd == "view" else {
            "path": path, "old_str": args.get("old_str", ""), "new_str": args.get("new_str", "") or ""}
        return name, new_args, f"Error: ENOENT: no such file or directory, open '{path}'"
    if cmd == "view":
        return convert_view(args, obs)
    if cmd == "create":
        content = rel_text(args.get("file_text", ""))
        if "File created successfully" not in obs:
            raise Skip("create failed")
        return "write_file", {"path": path, "content": content}, f"Wrote {path} ({content.count(chr(10)) + 1} lines)."
    if cmd == "str_replace":
        new_args = {"path": path, "old_str": rel_text(args.get("old_str", "")), "new_str": rel_text(args.get("new_str", "") or "")}
        if "has been edited" in obs:
            return "edit_file", new_args, f"Edited {path}."
        if "did not appear verbatim" in obs:
            return "edit_file", new_args, (
                "Error: old_str was not found in the file. Read the file again and copy the text exactly, including indentation."
            )
        m = re.search(r"Multiple occurrences of old_str.*?lines \[([^\]]*)\]", obs, re.S)
        if m:
            n = len([x for x in m.group(1).split(",") if x.strip()])
            return "edit_file", new_args, f"Error: old_str occurs {n} times. Include more surrounding lines so it is unique."
        raise Skip("unknown str_replace result")
    raise Skip(f"unsupported editor command: {cmd}")


def parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        raise Skip("bad tool arguments") from e


def convert_row(row: dict, max_chars: int = 40000) -> dict:
    if not row.get("resolved"):
        raise Skip("not resolved")
    msgs = row["messages"]
    if isinstance(msgs, str):
        msgs = json.loads(msgs)
    repo = re.sub(r"[^A-Za-z0-9_.-]", "-", (row.get("instance_id") or "project").split(".")[0])

    out = [{"role": "system", "content": system_prompt(repo)}]
    # Tool results arrive after the assistant message that requested them.
    pending: dict[str, tuple[str, dict]] = {}
    finished = False

    for m in msgs:
        role = m.get("role")
        if role == "system":
            continue
        if role == "user":
            if len(out) > 1:
                raise Skip("multi-turn user messages")
            out.append({"role": "user", "content": clean_user(text_of(m.get("content")))})
            continue
        if role == "assistant":
            content = rel_text(text_of(m.get("content"))).strip()
            calls = m.get("tool_calls") or []
            if any(c["function"]["name"] == "submit" for c in calls):
                if len(content) < 40:
                    raise Skip("no final summary")
                out.append({"role": "assistant", "content": content})
                finished = True
                break
            new_calls = []
            for c in calls:
                cid = c.get("id") or f"call_{len(out)}_{len(new_calls)}"
                pending[cid] = (c["function"]["name"], parse_args(c["function"].get("arguments")))
                new_calls.append(cid)
            msg = {"role": "assistant", "content": content or None}
            if new_calls:
                msg["tool_calls"] = new_calls  # filled in when results arrive
            out.append(msg)
            continue
        if role == "tool":
            ids = m.get("tool_call_ids") or [m.get("tool_call_id")]
            obs = observation(m.get("content"))
            for cid in ids:
                if cid not in pending:
                    raise Skip("tool result without call")
                name, args = pending.pop(cid)
                if name == "bash":
                    command = rel_text(args.get("command", ""))
                    if not command.strip():
                        raise Skip("empty command")
                    if obs.startswith("Your command ran successfully and did not produce any output"):
                        result = "exit code: 0\n"
                    else:
                        result = rel_text(obs)
                    new_name, new_args = "run_command", {"command": command}
                elif name == "str_replace_editor":
                    new_name, new_args, result = convert_editor(args, obs)
                else:
                    raise Skip(f"unknown tool {name}")
                # Replace the placeholder id in the matching assistant message.
                for prev in reversed(out):
                    if prev["role"] == "assistant" and cid in (prev.get("tool_calls") or []):
                        i = prev["tool_calls"].index(cid)
                        prev["tool_calls"][i] = {
                            "id": cid,
                            "type": "function",
                            "function": {"name": new_name, "arguments": json.dumps(new_args, ensure_ascii=False)},
                        }
                        break
                out.append({"role": "tool", "tool_call_id": cid, "name": new_name, "content": truncate(result)})
            continue

    if not finished:
        raise Skip("never finished")
    if pending:
        raise Skip("unanswered tool calls")
    for m in out:
        if m["role"] == "assistant" and any(isinstance(c, str) for c in m.get("tool_calls", [])):
            raise Skip("unanswered tool calls")
    # Source outputs mix \r\n and \n; PerDev's edit_file works in \n, so normalize everything.
    for m in out:
        if m.get("content"):
            m["content"] = m["content"].replace("\r\n", "\n")
        for c in m.get("tool_calls") or []:
            args = {k: v.replace("\r\n", "\n") if isinstance(v, str) else v for k, v in json.loads(c["function"]["arguments"]).items()}
            c["function"]["arguments"] = json.dumps(args, ensure_ascii=False)
    size = sum(len(m.get("content") or "") + len(json.dumps(m.get("tool_calls", ""))) for m in out)
    if size > max_chars:
        raise Skip("too long")
    return {"messages": out, "source": "swe-smith", "id": row.get("traj_id") or row.get("instance_id")}


def iter_rows(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".jsonl":
        for line in text.splitlines():
            if line.strip():
                yield json.loads(line)
        return
    data = json.loads(text)
    rows = data.get("rows", data) if isinstance(data, dict) else data
    for r in rows:
        yield r.get("row", r)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--max-chars", type=int, default=40000, help="skip conversations longer than this")
    a = ap.parse_args()

    kept, skipped = 0, {}
    with a.out.open("w", encoding="utf-8") as f:
        for row in iter_rows(a.input):
            try:
                ex = convert_row(row, a.max_chars)
            except Skip as e:
                reason = str(e).split(":")[0]
                skipped[reason] = skipped.get(reason, 0) + 1
                continue
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
            kept += 1
    print(f"kept {kept}, skipped {sum(skipped.values())}: {skipped}")


if __name__ == "__main__":
    main()

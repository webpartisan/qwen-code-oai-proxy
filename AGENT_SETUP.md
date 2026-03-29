# Local Qwen Agent Setup

These files are local-only and are not stored in git.
Each developer must create or update these exact paths on their own machine:

- `C:\Users\<USERNAME>\.codex\agents\qwen-coder.toml`
- `C:\Users\<USERNAME>\.codex\config.toml`

`C:\Users\<USERNAME>\.codex\agents\qwen-coder.toml` defines the local `qwen_coder` agent:

```toml
name = "qwen_coder"
description = "Implementation-only coding agent."
model_provider = "qwen-local"
model = "qwen-coder"
sandbox_mode = "workspace-write"
developer_instructions = """
You are a narrow-scope execution agent.
Work only on the task you were given.
Prefer one small concrete task at a time.

General rules:
- Do not speculate.
- Do not claim success without an actual result.
- Report exact observed errors, not guessed causes.
- If a strict output format was requested, follow it exactly.
- Do not touch unrelated files.
- If the task is read-only, do not edit files.
- If the task is a single-file edit, edit only that file.
- When writing multi-line content, use real newlines.
- Do not output pseudocode when real execution was requested.

For investigation tasks:
- Inspect only the files explicitly named in the task, unless the task explicitly allows more.
- Base conclusions only on code you actually inspected.
- Prefer concrete findings over general advice.

For coding tasks:
- Keep changes minimal and local.
- Verify the result with the simplest relevant check when feasible.
- Summarize only the concrete result, not raw logs.
"""
```

`C:\Users\<USERNAME>\.codex\config.toml` points provider `qwen-local` to this proxy.
The host and port below are the current local example from this setup and can be changed if another machine uses a different address:

```toml
model = "gpt-5.4"
[windows]
sandbox = "elevated"

[model_providers.qwen-local]
name = "Qwen provider"
base_url = "http://localhost:8082/v1"
wire_api = "responses"
```

After these two files are in place, Codex can use the local `qwen_coder` agent through this proxy.

Important: agent conversation/continuation state is currently stored only in the running proxy application's memory. Restarting the application clears that state, so existing agent threads and continuation context are lost after a restart.

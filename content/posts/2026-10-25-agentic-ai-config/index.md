---
title: "How I Run an Agentic AI Setup with OpenCode"
date: 2026-10-25
lastmod: 2026-10-26
slug: "agentic-ai-config"
description: "A map of the OpenCode configuration behind my AI coding workflow: one orchestrator, specialist agents, shared rules, tools, plugins, and how it is deployed."
summary: "The agents, rules, tools, and provisioning that make up my agentic AI coding setup, and how the pieces connect."
tags: ["ai", "opencode", "agents", "devops", "ansible"]
showDate: true
---

I do not use one chatbot for coding. I run a small team of agents. One orchestrator receives my request, splits the work, and hands pieces to specialists. Shared rules keep each agent small and checkable. The whole setup lives in a Git repository and is deployed with Ansible. This is a map of the tooling and its failure modes, not a measured productivity claim or an autonomous deployment system.

This post maps the parts, shows how they connect, and lists what I learned the hard way.

## System design: the big picture

{{< mermaid >}}
flowchart LR
  Me["Me"] --> Orch["Orchestrator"]
  Orch --> Spec["Specialist agents"]
  Orch --> Task["Task profiles"]
  Spec --> Tools["MCP tools"]
  Task --> Tools
  Rules["AGENTS.md rules"] -.-> Orch
  Rules -.-> Spec
  Skills["Skills"] -.-> Orch
  Plugins["Plugins"] -.-> Orch
  Repo["workstation-wsl repo"] -->|"Ansible deploys"| Home["~/.config/opencode"]
  Home --> Orch
{{< /mermaid >}}

The repo is the source of truth. Ansible copies the tracked config into my home directory, and OpenCode reads it from there.

## Configuration layers

| Layer | What it holds | Where it lives |
|---|---|---|
| Instructions | Global rules and repo rules | `AGENTS.md` files |
| Orchestration | Orchestrator and specialist roles, model presets | `oh-my-opencode-slim.jsonc` |
| Task profiles | `quick`, `build`, `fast`, `deep`, plus infra, incident, IaC, security, performance, automation, docs | `opencode.jsonc` |
| Tools | Context7, GitHub, filesystem, Docker, Kubernetes, Atuin | `opencode.jsonc` (MCP) |
| Plugins | Notifier, quota, model discovery, orchestration, context pruning, observability, goals, skill creator, Ponytail, Tavily | `opencode.jsonc` (plugins) |
| Skills | Reusable workflows: brainstorming, debugging, TDD, code review, worktrees | `~/.config/opencode/skills` |
| Commands | `review`, `fix-test`, `commit` (never pushes), `pr` draft, `caveman` style | `opencode.jsonc` (commands) |
| Deployment | Provisioning and repo command interface | Ansible role, `Makefile` |

## Orchestration and task decomposition

The orchestrator is the default agent. It plans and delegates. It does not do bulk searching or large edits itself.

{{< mermaid >}}
sequenceDiagram
  participant Me
  participant O as Orchestrator
  participant E as Explorer
  participant F as Fixer
  participant V as Oracle
  Me->>O: Task
  O->>E: Find code and docs (parallel)
  E-->>O: Findings with file paths
  O->>F: Bounded change with scope and check
  F-->>O: Diff summary
  O->>V: Only for risky design or repeated failure
  V-->>O: Advice
  O-->>Me: Result and verification
{{< /mermaid >}}

The roles:

- **Orchestrator**: plans, dispatches work in parallel, checks results.
- **Explorer**: read-only search, file lookup, and library docs.
- **Fixer**: bounded implementation, multi-file or mechanical edits.
- **Designer**: all UI and UX work. The orchestrator never does design itself.
- **Oracle**: escalation for architecture, risk, and debugging after two failed fixes.
- **Observer**: reads images and PDFs, so media bytes stay out of the main context.
- **Council**: three seats (alpha, beta, gamma) on different models. Their answers are synthesized into one view.
- **Review agents** from the marketplace: documenter, janitor, paladin (security), arbiter (review), chronicler (docs), hunter (error paths), proctor (test sufficiency).

## Shared policy and context

Rules load in a fixed order. Global rules come first, then the repo rules, then the agent's own prompt and permissions.

{{< mermaid >}}
flowchart TD
  G["Global AGENTS.md"] --> R["Repo AGENTS.md"]
  R --> A["Agent prompt and permissions"]
  A --> T["Task"]
{{< /mermaid >}}

The main rules are short:

- Read before editing. Search with targeted grep or glob.
- Make the smallest correct diff. No unrelated refactors.
- Verify with the narrowest check first.
- Use `make` targets as the only command interface.
- Keep terminal output short (`-s`, `--quiet`, or `| tail`).
- If an approach fails twice, change approach or escalate.
- Ask one question only when the answer changes the outcome. Otherwise decide and state the assumption.

Two style skills sit on top: Ponytail pushes for the smallest change that fully works, and caveman keeps chat replies terse.

## Model routing and failure modes

Each role has a model preset. Presets pick cheap, mid, or high-cost models per role. If a call fails, the plugin retries twice, then moves to the next model in the chain.

{{< mermaid >}}
flowchart LR
  Req["Agent call"] --> M1["Primary model"]
  M1 -->|"fails twice"| M2["Next model in chain"]
  M2 -->|"fails twice"| M3["Next model in chain"]
  M3 --> Err["Report failure"]
{{< /mermaid >}}

## Trust boundaries and permissions

- Review and triage agents deny edits. Implementation agents allow them.
- Atuin history access is denied by permission.
- The filesystem tool is scoped to `~/code`.
- The `commit` command never pushes.
- The OpenRouter key is set up during provisioning, with secret logging suppressed.
- The npm config keeps `engine-strict` and `prefer-offline` off, so plugin updates do not fail.

## Provisioning and deployment

{{< mermaid >}}
flowchart LR
  Git["Git repo sftp/.config"] -->|"Ansible"| Home["~/.config/opencode"]
  Ansible["opencode.yml role"] -->|"installs"| UI["OpenChamber and key service"]
  Make["Makefile"] -->|"make lint and checks"| Git
{{< /mermaid >}}

Ansible deploys the tracked config. The `Makefile` holds the lint, syntax, and check targets, and the agents are told to verify through them.

## Operational lessons

- **Two copies drift.** The tracked and installed configs differ, for example in the default model. Deploy from the repo only, and never edit the home copy by hand.
- **Agent permissions override global ones.** An allow in an agent's config beats a global deny. I removed shell allows from agents for this reason.
- **Strict npm settings break plugins.** `engine-strict=true` makes updates fail on engine mismatches. `prefer-offline=true` misses newly published versions.
- **Some plugins are off.** The metrics plugin is commented out because of a TUI compatibility issue.
- **Model names change.** Keep presets in one file so a swap touches one place.

## Trade-offs and next improvements

Keep the orchestrator, the rule files, and the `Makefile` interface. These do most of the work. Cut any plugin or agent that I have not used in a month. Every extra agent is one more thing to route, permission, and debug.

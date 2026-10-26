---
title: "An AI-Ready Full-Stack Blueprint: Rust, OpenAPI, and Guardrails"
date: 2026-02-01
lastmod: 2026-10-26
slug: "ai-full-stack"
draft: false
description: "A proposed contract-first Rust and OpenAPI workflow for AI-assisted full-stack engineering, with explicit validation and human review gates."
tags:
  - ai
  - cicd
  - rust
  - openapi
summary: "A proposed contract-first workflow for AI-assisted full-stack changes, with clear validation gates and limits."
---

This is a **design blueprint**, not a report of a deployed Rust product or measured AI productivity gains. It describes how I would structure a Rust API and static frontend so an AI coding assistant can make small, reviewable changes without guessing at interfaces.

## The problem: make changes local and checkable

A request that crosses backend and frontend boundaries is easy to get subtly wrong: route shapes drift, generated clients become stale, and a passing build may still miss behavior. The goal is to give both people and coding agents a contract and a short feedback loop—not to let an agent deploy unreviewed code.

## System design: one API contract

{{< mermaid >}}
flowchart LR
  Spec[OpenAPI contract] --> Server[Generated Rust server bindings]
  Spec --> Client[Generated UI client]
  Server --> Service[Services and repositories]
  Client --> UI[Static UI]
  Service --> Tests[Focused tests and checks]
  UI --> Tests
{{< /mermaid >}}

- **OpenAPI** defines request and response shapes; server and client bindings are generated from it.
- **Controllers/handlers** translate transport details; **services** own business rules; **repositories** isolate persistence.
- The UI consumes the generated client rather than maintaining a second handwritten API contract.
- Generation is repeatable, so generated files are outputs of a reviewed contract change—not independent sources of truth.

These boundaries help an AI assistant locate the smallest relevant layer. They do not prevent a bad change by themselves.

## Workflow: ask, constrain, verify, review

For a cross-stack change, the proposed loop is:

1. State behavior and acceptance checks before editing.
2. Change the OpenAPI contract if the external API changes.
3. Regenerate bindings and inspect the generated diff.
4. Implement service behavior and UI integration in their respective layers.
5. Run focused tests, then lint/type checks and a production build.
6. Have a person review the diff and any generated output before merge or deploy.

{{< mermaid >}}
flowchart TD
  Request[Request and acceptance checks] --> Plan[Locate contract and affected layers]
  Plan --> Edit[Contract, generated bindings, implementation]
  Edit --> Checks[Focused tests, lint and build]
  Checks --> Pass{Checks pass?}
  Pass -->|No| Fix[Diagnose and revise]
  Fix --> Checks
  Pass -->|Yes| Review[Human review]
  Review -->|Approved| Merge[Merge and deploy through normal release process]
{{< /mermaid >}}

The agent should report what it changed, what it ran and what remains uncertain. A green test suite is evidence for the tested behavior, not proof of correctness or authorization to deploy.

## Guardrails: contracts are not a substitute for judgment

- Keep credentials, production data and deployment permissions out of the coding agent's scope unless a task explicitly requires them.
- Validate at API boundaries; generated types cannot validate untrusted runtime input by themselves.
- Test error cases and authorization as well as happy paths.
- Review generated code and dependency changes; generation can propagate a mistaken contract consistently.
- Treat tests as executable expectations, not as a guarantee that the requirements are complete.

## Cost and scaling: no invented break-even curve

Serverless can avoid paying for idle capacity, while long-running or high-volume workloads may favor provisioned infrastructure. The break-even point depends on workload shape, provider pricing, latency targets and operational effort. The illustrative request-cost chart and migration thresholds from the earlier draft were not based on a measured workload, so they are intentionally omitted here.

Likewise, this design has no benchmark showing AI-assisted development is faster. A credible evaluation would compare representative tasks with and without assistance, recording review time, rework, defects and total cost—not just generated lines or first-pass test results.

## What is implemented, and what is proposed

The article presents a **proposed workflow**; I found no evidence in this portfolio repository of the Rust SaaS, OpenAPI generation pipeline or request-to-PR agent described in the earlier version. The repository's real AI application is the [portfolio RAG assistant](/posts/2026-01-25-ai-chat/); the actual coding-agent configuration is documented in [How I Run an Agentic AI Setup with OpenCode](/posts/2026-10-25-agentic-ai-config/).

The practical design principle is simple: give automation narrow interfaces, deterministic checks and a human release gate. Add agent autonomy only when the workflow has evidence that each step is safe and useful.

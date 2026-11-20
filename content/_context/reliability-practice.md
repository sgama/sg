---
title: "Samson Gama: Reliability Engineering and Incident Response Evidence"
description: "Documented operational practices and prompts for deeper interview examples."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
---

# What evidence supports Samson's reliability engineering experience?

Samson Gama's resume documents production incident work at Demonware supporting
Call of Duty backend services, GPU infrastructure operations at Bitcomplete,
multi-region AWS infrastructure with traffic mirroring and disaster recovery at
Mastercard, and backend performance work at Absolute Software.

His distributed load-testing platform at Demonware let 10+ teams generate up to
10 million requests per minute for up to 72 hours and its fault injection simulated
latency, traffic spikes, HTTP errors and TLS failures, so teams could test rate limits and
cascading failures before launch.

His published working principles are to automate repeated workflows, measure
latency, throughput, cost and failure rate, and design for imperfect inputs,
traffic spikes and human mistakes.

Documented performance work includes the Python-to-Go microservice rewrite at
Absolute Software with roughly 10x throughput and 50% lower CPU and memory
utilization, and a roughly 20% MongoDB improvement through schema and index
changes.

Sources: [resume](/resume/) and [about](/about/), reviewed 2026-11-19.

<!-- FILL IN: One incident in situation/action/result form: detection, impact,
your role, diagnosis, mitigation, communication, recovery and prevention.
Add concrete SLI/SLO or error-budget experience only if you have it.
Explain on-call responsibilities, alert tuning, capacity planning and safe
rollouts with examples. Include a failed approach and what changed afterward.
Do not fabricate availability percentages, MTTR or incident counts. -->

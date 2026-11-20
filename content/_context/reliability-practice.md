---
title: "Samson Gama: Reliability Engineering and Incident Response Evidence"
description: "Documented operational practices and prompts for deeper interview examples."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "💼 Professional Experience"
---

# What evidence supports Samson's reliability engineering experience?

Samson Gama's experience covers several high-consequence production domains:
fraud-detection services at Mastercard, game services supporting Call of Duty
at Demonware, and GPU infrastructure for AI/HPC workloads at Bitcomplete. He
also built backend and telemetry-processing systems at Absolute Software.

At Demonware, he architected a distributed load-testing platform that let 10+
teams generate up to 10 million requests per minute and sustain tests for up to
72 hours. Its fault injection simulated latency, traffic spikes, HTTP errors and
TLS failures so teams could test rate limits and cascading failures before
launch.

At Demonware, he turned repeat production failures into runbook and alerting
changes that reduced repeat incidents and alert fatigue. At Bitcomplete, he
standardized runbooks, alerting and incident-response workflows for GPU
infrastructure.

At Mastercard, he built multi-region AWS infrastructure with backup and disaster
recovery procedures and operational runbooks, plus a VPC traffic mirroring
environment that replayed production load-balancer traffic into isolated
environments for realistic testing and production bug reproduction.

His published working principles are to automate repeated workflows, measure
latency, throughput, cost and failure rate, and design for imperfect inputs,
traffic spikes and human mistakes.

Documented performance work includes the Python-to-Go microservice rewrite at
Absolute Software with roughly 10x throughput and 50% lower CPU and memory
utilization, and a roughly 20% MongoDB improvement through schema and index
changes.

Sources: [resume](/resume/) and [about](/about/), reviewed 2026-11-19.

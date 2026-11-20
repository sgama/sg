---
title: "Samson Gama at Demonware: Load Testing and Production Reliability"
description: "Demonware role, platform technologies and engineering ownership."
draft: false
retrievalSource: "content/resume/_index.md"
retrievalSection: "💼 Professional Experience"
---

# Samson Gama at Demonware: distributed load testing and reliability, 2020-2026

Samson Gama was Senior Software Engineer at Demonware (Activision),
Aug 2020 - Jan 2026, supporting backend services and engineering platforms
behind the Call of Duty franchise.

He architected and built a distributed load-testing platform from scratch in
Go, Kubernetes and Redis, implementing horizontally scalable traffic generation
and Redis-backed distributed token-bucket rate limiting. It let 10+ engineering teams company-wide generate up to 10 million requests
per minute across multiple services, sustaining load tests of up to 72 hours.

He added configurable fault injection for latency, traffic spikes, HTTP errors
and TLS failures, so teams could evaluate rate-limit behavior, identify
cascading service failures and validate resilience under load.

He supported backend services and engineering platforms powering Call of Duty
titles with millions of concurrent players, diagnosing production incidents
under peak live traffic and turning repeat failures into runbooks and alerting
changes that reduced repeat incidents and alert fatigue.

He developed features in Python backend microservices that integrated Apple,
Google, Xbox and PlayStation Network commerce platforms with internal
entitlement services, including event-driven reconciliation across purchases,
logins and asynchronous fulfillment.

He authored RFCs and technical proposals for migrating MySQL databases
exceeding 1 TB to Vitess, covering schema and query compatibility, required
schema changes and ORM-managed migration plans with rollback procedures.

He standardized Kubernetes deployments with reusable Helm charts, templates
and internal tooling, automated environment provisioning, and supported seven
game launches. He also established company-wide conf.d configuration standards
and resource-utilization practices across backend services and contributed to architecture reviews, Python code
reviews and mentoring of junior engineers.

Source: [resume](/resume/), reviewed 2026-11-19.

<!-- FILL IN: Which services and launch windows the load-testing platform was
used for, its coordination and failure-handling model, and measured adoption
outcomes. Add one incident story and one technical trade-off, separating your
own decisions from team contributions. Use only employer-approved information;
do not include operational vulnerabilities or confidential player data. -->

---
title: "Call of Duty: Black Ops 7"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2025-09-14
slug: "call-of-duty-bo7"
tags: ["backend", "gaming", "infrastructure", "reliability"]
---

![Key art for Call of Duty: Black Ops 7](featured.webp)

## 🎯 Scope

Supported backend services and engineering platforms behind **Call of Duty: Black Ops 7** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## 🛠️ What I Owned

- **Validated launch-scale capacity**: Ran distributed load tests with the internal Go, Kubernetes, and Redis platform to establish capacity for peak traffic and live-event surges.
- **Exercised failure modes**: Tested services under injected latency, HTTP errors, and TLS failures, including rate-limit and cascading-failure behavior.
- **Improved backend services**: Developed and reviewed Python microservice changes behind online features, with safe rollout through standardized deployment paths.
- **Incident response**: Triaged production incidents during live traffic and converted repeat failures into alerting and runbook changes.
- **Standardized platform deployment**: Reused Helm charts, templates, and conf.d configuration conventions to reduce drift across backend services.

## 📈 Outcomes

- Established capacity and resilience evidence ahead of the launch window.
- Reduced operational toil through automated provisioning and consistent deployment patterns.
- Improved incident follow-through by closing the failure modes production exposed.

I used the load-testing platform and fault injection across the Demonware titles I supported, not just one release.

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem

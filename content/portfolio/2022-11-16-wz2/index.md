---
title: "Call of Duty: Warzone 2.0"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty: Warzone 2.0."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2022-11-16
slug: "call-of-duty-wz2"
tags: ["backend", "gaming", "infrastructure", "reliability"]
---

![Key art for Call of Duty: Warzone 2.0](featured.webp)

## 🎯 Scope

Supported backend services and engineering platforms behind **Call of Duty: Warzone 2.0** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## 🛠️ What I Owned

- **Stress-tested high-concurrency traffic**: Ran sustained load validation with the internal Go, Kubernetes, and Redis platform to size capacity and expose bottlenecks before peak demand.
- **Exercised failure modes**: Used configurable fault injection for latency, traffic spikes, HTTP errors, and TLS failures to verify degraded-service behavior under load.
- **Improved backend services**: Contributed Python microservice changes behind online features, with review and safe rollout through standardized deployments.
- **Incident response**: Investigated production incidents during live traffic and turned recurring failures into runbook and alerting updates.
- **Standardized platform deployment**: Applied reusable Helm charts and templates across services to reduce configuration drift.

## 📈 Outcomes

- Produced capacity and resilience evidence for services facing sustained concurrent load.
- Reduced repeat operational toil through automated deployment and provisioning workflows.
- Improved production signal quality for the services the release depended on.

I used the load-testing platform and fault injection across the Demonware titles I supported, not just one release.

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem

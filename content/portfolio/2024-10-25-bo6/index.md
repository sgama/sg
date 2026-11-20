---
title: "Call of Duty: Black Ops 6"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty: Black Ops 6."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2024-10-25
slug: "call-of-duty-bo6"
tags: ["backend", "gaming", "infrastructure", "reliability"]
---

![Key art for Call of Duty: Black Ops 6](featured.webp)

## 🎯 Scope

Supported backend services and engineering platforms behind **Call of Duty: Black Ops 6** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## 🛠️ What I Owned

- **Validated launch capacity**: Ran distributed load tests with the internal Go, Kubernetes, and Redis platform, including sustained runs at high request rates to prove service headroom.
- **Exercised failure modes**: Simulated latency, traffic spikes, HTTP errors, and TLS failures to find cascading failures before players did.
- **Improved backend services**: Contributed Python microservice changes behind online features, with code review and staged rollout.
- **Incident response**: Diagnosed production incidents during live traffic and fed the results back into alerting, runbooks, and platform fixes.
- **Standardized platform deployment**: Applied reusable Helm charts and templates to reduce drift between services and environments.

## 📈 Outcomes

- Gave service teams capacity and failure-mode evidence ahead of launch demand.
- Reduced repeat operational work by automating provisioning and deployment paths.
- Strengthened production signal quality on the critical service paths.

I used the load-testing platform and fault injection across the Demonware titles I supported, not just one release.

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem

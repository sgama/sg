---
title: "Call of Duty: Vanguard"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty: Vanguard."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2021-11-05
slug: "call-of-duty-vanguard"
tags: ["backend", "gaming", "infrastructure", "reliability"]
---

![Key art for Call of Duty: Vanguard](featured.webp)

## 🎯 Scope

Supported backend services and engineering platforms behind **Call of Duty: Vanguard** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## 🛠️ What I Owned

- **Launch load validation**: Ran load tests against release-candidate services to size capacity for peak multiplayer traffic.
- **Failure injection**: Exercised services under injected latency and error conditions to check rate-limit and degraded-mode behavior.
- **Backend service changes**: Contributed to Python backend microservices behind online features, including code review and safe rollout.
- **Incident response**: Triaged production incidents during live traffic and turned repeat failures into runbooks and alerting changes.
- **Deployment standardization**: Standardized Kubernetes deployments with reusable Helm charts and templates.

## 📈 Outcomes

- Established capacity and failure-mode evidence ahead of the release window.
- Reduced repeat operational toil through consistent deployment and configuration patterns.
- Improved incident response by feeding production findings back into alerting and runbooks.

*The load-testing platform, fault injection, and deployment standards described here were built and maintained across the Demonware titles I supported, not for a single release.*

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem

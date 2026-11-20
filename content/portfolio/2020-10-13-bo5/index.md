---
title: "Call of Duty: Black Ops Cold War"
summary: "Backend engineering, reliability, and scaling work for Demonware services supporting Call of Duty: Black Ops Cold War."
weight: 100
showDate: false
date: 2020-10-13
slug: "call-of-duty-bo5"
tags: ["backend", "gaming", "infrastructure", "reliability"]
---

![Key art for Call of Duty: Black Ops Cold War](featured.webp)

## 🎯 Scope

Supported backend services and engineering platforms behind **Call of Duty: Black Ops Cold War** at **Demonware (Activision)**, as part of the team serving millions of concurrent players.

## 🛠️ What I Owned

- **Live-service operations**: Operated production backend services through the launch window and the live events that followed, prioritizing safe releases and fast recovery.
- **Capacity and launch readiness**: Prepared services and infrastructure for launch demand, including capacity checks and load tests against release candidates.
- **Rate limiting and failure behavior**: Tested service behavior under load and degraded conditions before release.
- **Incident response**: Triaged production issues during live traffic and fed repeated failures into runbooks and alerting changes.
- **Deployment standardization**: Applied reusable Helm templates and shared conf.d configuration conventions to reduce drift between services.

## 📈 Outcomes

- Carried live-service backend support through a launch window.
- Reduced repeat operational work by standardizing deployment templates and configuration.
- Improved incident follow-through by converting recurring failures into permanent fixes.

*The load-testing platform, fault injection, and deployment standards described here were built and maintained across the Demonware titles I supported, not for a single release.*

**Tech Stack:**

- **Languages**: Python, C++, Go, Bash
- **Infrastructure**: Kubernetes, On-Prem

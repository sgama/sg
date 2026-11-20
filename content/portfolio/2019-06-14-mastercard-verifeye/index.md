---
title: "Dynamic Biometrics (Verifeye)"
summary: "Designed a payments-auth concept that combined facial verification and sentiment cues to strengthen identity checks without adding unnecessary friction."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2019-06-14
slug: "mastercard-verifeye"
tags: ["biometrics", "cybersecurity", "machine-learning"]
---

![Verifeye facial-recognition multi-factor authentication concept wireframe](featured.webp)

**Verifeye** was a proof of concept I built during Mastercard's Innovation Week. The project rethought payment authentication for a high-stakes environment where false positives and customer friction both carry real cost.

## 💡 The Concept

I designed a passive authentication layer that could work in the background during a transaction.

### 1. Identity Verification

- **Facial Identity Checks**: Used computer vision to compare the user's estimated demographics against the cardholder record.
- **Liveness Detection**: Explored liveness detection to distinguish a real person from a photograph (proof of concept).

### 2. User Sentiment

- **Friction Analysis**: Modeled facial expressions to detect customer frustration or confidence during checkout and tune the experience in real time.

{{< figure src="/portfolio/2019-06-14-mastercard-verifeye/verifeye-2.webp" title="Initial Screen" >}}
{{< figure src="/portfolio/2019-06-14-mastercard-verifeye/verifeye-0.webp" title="Debug View (Facial Landmarks)" >}}

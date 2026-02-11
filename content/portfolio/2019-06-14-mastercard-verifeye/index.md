---
title: "Dynamic Biometrics (Verifeye)"
summary: "Multi-factor authentication concept using facial recognition and sentiment analysis to verify identity and gauge user friction during transactions."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2019-06-14
slug: "mastercard-verifeye"
tags: ["biometrics", "cybersecurity", "machine-learning"]
---

![Featured image](featured.webp)

**Verifeye** was a Proof of Concept (PoC) developed during Mastercard's Innovation Week. The project aimed to rethink payment authentication by moving beyond static passwords to dynamic biological markers.

## The Concept

We designed a passive authentication layer that works in the background during a transaction.

### 1. Identity Verification

- **Facial Age/Gender Estimation**: Used computer vision to compare the user's estimated demographics against the cardholder's file.
- **Liveness Detection**: Ensured the user is a real person and not a photograph.

### 2. User Sentiment

- **Friction Analysis**: Analyzed facial expressions to determine "customer delight" or frustration during the checkout flow. This data could help merchants optimize their UX.

{{< figure src="/portfolio/2019-06-14-mastercard-verifeye/verifeye-2.webp" title="Initial Screen" >}}
{{< figure src="/portfolio/2019-06-14-mastercard-verifeye/verifeye-0.webp" title="Debug View (Facial Landmarks)" >}}

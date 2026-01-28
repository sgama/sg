---
title: "Biomedical Engineering: Photoelectric Heart Rate Monitor"
summary: "Designed and built a microcontroller-based photoplethysmogram (PPG) sensor to calculate heart rate from blood flow variations."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2014-03-01
slug: "heart-rate-monitor"
tags: ["biomedical", "embedded-systems", "signal-processing", "c-programming", "hardware"]
---

For this module, I executed the full lifecycle design—build, program, and test—of a **photoelectric heart rate monitor**.

## Operational Principle

The device functioned as a **photoplethysmogram (PPG)** sensor. It utilized a non-invasive photo transmitter/receiver pair clipped to a finger.

1. **Sensing**: The sensor detected minute variations in light absorption caused by the volumetric change of blood flow with each heartbeat.
2. **Signal Processing**: The raw analog data was filtered and amplified to isolate the heartbeat signal from noise.
3. **Calculation**: A microcontroller algorithm measured the period between peaks to calculate the beats-per-minute (BPM) in real-time.

---
title: "FinTech: Algorithmic Trading Bot"
summary: "High-frequency crypto trading system achieving consistent returns via ML-driven pattern matching, built on a Go/InfluxDB microservices architecture."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2018-01-01
tags: ["fintech", "algorithmic-trading", "golang", "machine-learning", "time-series-db", "microservices", "influxdb"]
---
{{< figure src="/portfolio/2017-11-01-hft-bot/hft_btc_grafana.webp" title="Real-time Monitoring Dashboard" >}}

This project is a high-frequency trading (HFT) system designed to capitalize on volatility in the cryptocurrency markets. It evolved from a simple Python scraper into a robust distributed system capable of processing market data in nanoseconds.

## System Evolution

### 1. Data Engineering Limitations

I initially started with Python and PostgreSQL, but the sheer volume of tick data (Level 2 order books) created a bottleneck.

- **The Pivot**: Migrated to **Golang** for its raw performance and concurrency primitives.
- **Storage**: Switched to **InfluxDB** (Time Series Database) to handle millions of data points effectively without the write-lock overhead of relational databases.

### 2. Strategy & Analysis

Accumulating a 40GB+ dataset allowed for rigorous backtesting.

- **Pattern Matching**: Implemented algorithms to detect arbitrage opportunities and specific "market maker" patterns.
- **Machine Learning**: Utilized sentiment analysis and risk assessment models to filter trade signals.
- **Performance**: The bot achieved **0.5% weekly returns** (net of fees) during the testing period.

## Architecture

The system is composed of nine specialized microservices communicating via a message bus.

- **Ingestion**: Co-located VPS instances near exchange servers to minimize network latency.
- **Monitoring**: Full observability stack using **Grafana** to track "Tick-to-Trade" latency and system health.
- **ChatOps**: Integrated with **Slack** to broadcast trade decisions and predictive signals in real-time.

**Tech Stack:**

- **Language**: Golang, Node.js
- **Database**: InfluxDB, MongoDB
- **DevOps**: Docker, Grafana, Promethus
- **APIs**: REST, WebSockets (Exchange Feeds)

{{< figure src="/portfolio/2017-11-01-hft-bot/hft_btc_cc_charts.webp" title="Backtesting Simulation" >}}
{{< figure src="/portfolio/2017-11-01-hft-bot/hft_btc_slack.webp" title="Slack Notifications" >}}

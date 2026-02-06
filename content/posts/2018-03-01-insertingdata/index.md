---
title: 'Millions of Inserts: The Ideal Database?'
summary: 'A performance comparison of MongoDB, PostgreSQL, and InfluxDB for high-frequency trading data, handling millions of inserts per day.'
showPagination: true
invertPagination: true
showDate: true
date: 2018-03-01
slug: "insertingdata"
tags: ["database", "influxdb", "mongodb", "postgresql", "performance", "hft", "timeseries", "sql", "nosql"]
---

*Disclaimer: I didn't run synthetic benchmarks in High Availability (HA) mode for Proof of Concepts (POC). This post reflects my practical experience working with massive datasets for my HFT Trading Bot.*

## The Data Challenge

High-Frequency Trading (HFT) generates an enormous amount of data, all indexed by time. Here is the structure I needed to persist:

- **1 Minute Candle**: `{timestamp, instrument, high, low, open, close, volume, trades}` - ~1 insert per instrument/minute.
- **Individual Trade**: `{timestamp, instrument, price, side, type}` - 0 to 2,000 inserts per minute.
- **Individual Order**: `{timestamp, instrument, price, side, type, status}` - 0 to 5,000 inserts per minute.

*Note: I maintained one collection/database per exchange, as data quality and granularity varied between them.*

## Query Patterns

The database needed to support specific access patterns efficiently:

1. **Range Queries**: "Give me all trades between time X and Y for Instrument Z" (indexes on Time + Instrument).
2. **Latest Data**: "Give me the last X candles for Instrument Z" (heavy read load on recent data).

## Retention Policy

Storing this much data indefinitely is expensive and unnecessary for my algorithm.

- **Candle Data**: Pruned every 3 days.
- **Trade/Order Data**: Pruned every 3 hours. (A longer retention would be preferred, but the volume is manageable).

---

## Database Comparison

### 1. MongoDB (NoSQL)

**Pros:**

- **Write Throughput**: Handles thousands of inserts per minute exceptionally well with batching.
- **Flexibility**: Schema-less design made development fast.
- **Cleanup**: Enforcing retention via TTL indexes or CRON jobs is straightforward.

**Cons:**

- **Resource Hog**: Consumed excessive memory and disk space as the dataset grew.
- **Data Integrity**: **Data loss issues**. After ~10 million rows, I noticed gaps in the data.
- **Stability**: Batch inserts and queries began timing out as the collection size increased.
- **Scaling**: Required increasingly powerful hardware just to keep up.

**Verdict**: Not acceptable. Data loss is a critical failure for a trading algorithm.

### 2. PostgreSQL (SQL)

**Pros:**

- **Reliability**: ACID compliance meant zero data loss.
- **Simplicity**: Standard SQL for inserting, querying, and deleting was easy to implement.
- **Tools**: Excellent ecosystem and client libraries.

**Cons:**

- **Performance Decay**: Inserts slowed down significantly as tables grew into the millions of rows.
- **Maintenance**: Querying and deleting old data (vacuuming) impacted write performance.
- **Bloat**: Disk/Memory usage grew inefficiently for this specific workload.
- **Latency**: Unacceptable latency for real-time HFT decision making.

**Verdict**: Reliable, but too slow for the sheer volume of high-frequency time-series data.

### 3. InfluxDB (Time-Series DB)

**Pros:**

- **Purpose-Built**: Designed specifically for time-series data; "Time" is a first-class citizen.
- **Retention Policies**: Built-in support at the database level (no external cron jobs needed).
- **Reliability**: **Never lost a single data point** despite the high load.
- **Efficiency**: Incredible compression algorithms resulted in optimal disk usage compared to MongoDB.
- **Performance**: Consistent read/write speeds regardless of dataset size.

**Cons:**

- **Resources**: CPU usage can be high during heavy compaction.
- **Cardinality**: Required a workaround for events happening at the exact same millisecond (added a unique "match index" tag).

**Verdict**: ✅ **The Ideal Choice** for an HFT Trading Bot.

## Key Takeaways

- **MongoDB**: Great for general application data but struggled with integrity at this scale.
- **PostgreSQL**: The gold standard for reliability, but time-series is a specific niche where general SQL engines struggle without tuning (e.g., TimescaleDB).
- **InfluxDB**: The specialist tool won. It handled millions of data points flawlessly with built-in features that solved my specific problems (retention, time-indexing).

**Result**: InfluxDB became the foundation for my trading system, handling millions of inserts daily without losing a single record.

---
title: 'Millions of Inserts | The ideal database?'
summary: 'Performance comparison of MongoDB, PostgreSQL, and InfluxDB for high-frequency trading data - millions of inserts per day'
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2018-03-01
tags: ["database", "influxdb", "mongodb", "postgresql", "performance", "hft", "timeseries"]
---

*Disclaimer: I haven't ran any benchmarks or ran any of these databases in HA mode for proof of concepts but this was my experience with trying to work with lots of data for my HFT Trading Bot.*

## The Data Challenge

All data indexed on time:

- **1 minute candle**: `{timestamp, instrument, high, low, open close, volume, trades}` - 1 insert per minute
- **Individual trade**: `{timestamp, instrument, price, side, type}` - 0-2000 inserts per minute
- **Individual order**: `{timestamp, instrument, price, side, type, status}` - 0-5000 inserts per minute

*Note: There will exist one collection/database per exchange as certain exchanges provide more valuable information than others.*

## Query Patterns

- Between times x and y, on a certain instrument per exchange - hence two indexes on time and instrument
- Last x elements on a certain instrument per exchange - hence two indexes on time and instrument

## Retention Policy

- Candle data will need to be pruned every three days
- Trade and order data can be pruned every three hours. A longer retention policy would be preferred but that's a lot of data

---

## Database Comparison

### MongoDB (NoSQL)

**Pros:**

- Handles thousands of inserts per minute really well with batching
- Queries work seamlessly
- Enforcing retention policy through CRON is very easy

**Cons:**

- Consumed excessive memory and disk space as dataset grew
- **Data loss issues**: After ten million rows, data would start going missing
- Batch inserts and queries began timing out and failing
- Required increasingly powerful hardware to maintain performance

**Verdict**: Not acceptable for high-availability requirements due to data loss.

### PostgreSQL (SQL)

**Pros:**

- Simple to insert, query, and delete data
- No missing data observed
- Reliable data integrity

**Cons:**

- **Performance degradation**: Inserts got slower as tables grew larger
- Querying and deletion also slowed over time
- Growing disk space and memory consumption
- **Latency issues**: Unacceptable for HFT requirements

**Verdict**: Reliable but too slow for high-frequency trading use case.

### InfluxDB (TimeseriesDB)

**Pros:**

- **Purpose-built** for timeseries data - automatically indexed on time
- **Built-in retention policies** at database level
- **Never lost data** despite high load
- Optimal disk space usage compared to MongoDB
- Perfect fit for the use case

**Cons:**

- High memory and CPU consumption
- Required workaround for same-millisecond timestamps (added match index)

**Verdict**: ✅ **Ideal choice** for HFT Trading bot

## Key Takeaways

- **MongoDB**: Great for general use but failed at scale with data integrity issues
- **PostgreSQL**: Reliable but performance degradation made it unsuitable for real-time trading
- **InfluxDB**: Perfect for timeseries data with built-in retention and consistent performance

**Result**: InfluxDB became the foundation for a profitable trading system, handling millions of data points without losing a single record.

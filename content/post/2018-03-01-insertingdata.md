---
title: Millions of Inserts | The ideal database?
subtitle: TLDR - When Mongo isn't webscale
date: 2018-03-01
tags: ["database", "influxdb", "mongo", "postgres"]
---

Disclaimer: I haven't ran any benchmarks or ran any of these databases in HA mode for proof of concepts but this was my experience with trying to work with lots of data for my HFT Trading Bot.

The Data: (all indexed on time)
- 1 minute candle: {timestamp, instrument, high, low, open close, volume, trades}, 1 inserts per minute
- Individual trade: {timestamp, instrument, price, side, type}, 0-2000 inserts per minute
- Individual order: {timestamp, instrument, price, side, type, status}, 0-5000 inserts per minute

Note: There will exist one collection/database per exchange as certain exchanges provide more valuable information than others.

How the data will be queried:
- Between times x and y, on a certain instrument per exchange - hence two indexes on time and instrument
- Last x elements on a certain instrument per exchange - hence two indexes on time and instrument

Retention Policy:
- candle data will need to be pruned every three days
- trade and order data can be pruned every three hours. A longer retention policy would be preferred but that's a lot of data

---

MongoDB (NoSQL):

Mongo handles thousands of inserts per minute really well as batching makes it easy to do so. Queries work seamlessly as well. Enforcing a retention policy through CRON is very easy as well.
However that's where the good stuff ends. Mongo consumed a lot of memory and disk space as the dataset grew. This would have been acceptable if the data was consistent and none of the batch inserts or queries timed out or failed.
After ten million rows in the collections, data would start to go missing and clients would report errors all the time. Since the project required a database that was available all the time without blackout periods, Mongo was not the answer.
Moving to a more powerful VPS with more memory allowed the dataset to grow bigger before incurring the same errors as before, but that was not acceptable for my use case

Postgres (SQL):

Postgres was similar to Mongo where it was really simple to insert, query, and delete data. But it was also problematic when tables grew very large. Inserts got slower and slower causing data to be available to the system at a later time. Querying and deletion also got slower over time. Disk Space and memory also grew with the dataset size, however I did not notice any missing data this time. Given that this was meant to be a HFT bot, the slowdown caused by the larger datasets also meant that it was unacceptable for my use case. 

InfluxDB (NoSQL, TimeseriesDB):

InfluxDB is different from the previous two databases. This is a timeseries database. All data is automatically indexed on time, retention policies are supported at the database level, and my projects usecase for it fit its strengths perfectly.
Influx consumed a lot of memory and cpu, but not as much disk space as Mongo. Despite everything, InfluxDB would never lose any data I had. The only caveat was that I had to add a new field for trades and orders because you could not insert data with the same millisecond timestamp. So to counteract this issue, I added a match index which enumerated the number of orders or trades on the same millisecond timestamp so InfluxDB could see them as different objects.
Now with the automatic retention policy, InfluxDB was the ideal choice for me for my HFT Trading bot.
---
title: "Hackathon: FleetAware"
summary: "Award-winning Hackathon project utilizing the Mojio API to optimize logistics and routing for large-scale vehicle fleets."
showPagination: true
invertPagination: true
weight: 100
showDate: false
date: 2014-10-01
slug: "fleetaware"
tags: ["hackathon", "backend", "frontend"]
---

![Featured image](featured.webp)
{{< figure src="/portfolio/2014-10-01-fleetaware/fleetaware-post-0.webp" title="FleetAware Dashboard" >}}

**FleetAware** was developed during a 24-hour Hackathon with the goal of extending the capabilities of the **Mojio** connected car platform. While Mojio was designed for single-vehicle owners, we recognized an opportunity to scale the technology for enterprise fleet management (Rental agencies, Logistics, Taxi services).

## Technical Implementation

We reverse-engineered the Mojio consumer API to aggregate data from multiple devices into a single administrative dashboard.

**Features Implemented:**

1. **aggregated Tracking**: Real-time GPS location of all fleet vehicles on a master Google Map.
2. **Distance Geofencing**: Automated alerts if rental vehicles exceeded daily mileage limits.
3. **Route Optimization**: Algorithms to suggest fuel-efficient headers based on traffic data, beneficial for bus or delivery routing.

## Market Potential

We pitched a business model targeting the 360,000+ rental and taxi vehicles in North America. By providing the dashboard as a value-add service for bulk hardware purchases, we demonstrated a scalable B2B revenue stream—a pitch that resonated well with the judges.

## Outcomes

Our team successfully built a "market-ready" MVP (Minimum Viable Product) in under 20 hours. We delivered a working web application that could ingest live data from the Mojio vehicle simulator, alert managers of "problem vehicles," and visualize the entire fleet status instantly.

**Tech Stack:**

- **Frontend**: HTML5, CSS3, JavaScript (jQuery)
- **Maps**: Google Maps JS API
- **Backend**: PHP5
- **Hardware Integration**: Mojio REST API

*Challenge Post: [http://challengepost.com/software/fleetaware](http://challengepost.com/software/fleetaware)*

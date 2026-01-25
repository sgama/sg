# QA Suite

This directory contains the configuration for the Lighthouse QA testing suite.

## Prerequisites

- [Docker](https://www.docker.com/products/docker-desktop)
- [Docker Compose](https://docs.docker.com/compose/install/)
- A generated `public/` directory (run `hugo` before testing)

## Running the Tests

To run the Lighthouse audit against your generated site:

1. Build your site:
   ```bash
   hugo
   ```

2. Run the QA suite using Docker Compose:
   ```bash
   docker-compose up --build lighthouse
   ```
   Or if you didn't install the profile:
   ```bash
   docker-compose run lighthouse
   ```
   
   *Note: The `docker-compose.yml` is in the project root.*

## Config

The Lighthouse configuration is located in `tests/lighthouserc.js`. You can adjust assertions and settings there.

## Reports

HTML reports will be generated in the `results/` directory in the project root.

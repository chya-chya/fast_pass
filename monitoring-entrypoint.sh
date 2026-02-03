#!/bin/sh

# Default values if not set
: "${APP_TARGET:=app:3000}"
: "${PM2_METRICS_TARGET:=app:9209}"

echo "Generating prometheus.yml from template..."
echo "APP_TARGET: $APP_TARGET"
echo "PM2_METRICS_TARGET: $PM2_METRICS_TARGET"

sed -e "s|\${APP_TARGET}|$APP_TARGET|g" \
    -e "s|\${PM2_METRICS_TARGET}|$PM2_METRICS_TARGET|g" \
    /etc/prometheus/prometheus.yml.template > /etc/prometheus/prometheus.yml

echo "Configuration generated:"
cat /etc/prometheus/prometheus.yml

echo "Starting Prometheus..."
exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml

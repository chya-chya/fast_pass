#!/bin/sh

# Default values if not set
: "${APP_TARGET:=app:3000}"
: "${PM2_METRICS_TARGET:=app:9615}"

echo "Generating prometheus.yml from template..."
echo "AWS_REGION: ${AWS_REGION:-ap-northeast-2}"

sed -e "s|\${AWS_REGION}|${AWS_REGION:-ap-northeast-2}|g" \
    /etc/prometheus/prometheus.yml.template > /etc/prometheus/prometheus.yml

echo "Configuration generated:"
cat /etc/prometheus/prometheus.yml

echo "Starting Prometheus..."
exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml

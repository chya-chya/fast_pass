#!/bin/sh

: "${MONITORING_PROFILE:=test}"
: "${APP_TARGET:=app:3000}"
: "${PM2_METRICS_TARGET:=app:9209}"
: "${AWS_REGION:=ap-northeast-2}"

case "${MONITORING_PROFILE}" in
  test)
    : "${PROMETHEUS_SCRAPE_INTERVAL:=2s}"
    template=/etc/prometheus/prometheus.test.yml.template
    case "${PROMETHEUS_SCRAPE_INTERVAL}" in
      1s|2s|3s|4s|5s) ;;
      *) echo 'monitoring rejected: test scrape interval must be 1-5s' >&2; exit 1 ;;
    esac
    ;;
  production)
    : "${PROMETHEUS_SCRAPE_INTERVAL:=15s}"
    template=/etc/prometheus/prometheus.yml.template
    interval_seconds="${PROMETHEUS_SCRAPE_INTERVAL%s}"
    if [ "${interval_seconds}s" != "${PROMETHEUS_SCRAPE_INTERVAL}" ] ||
       ! [ "${interval_seconds}" -ge 15 ] 2>/dev/null; then
      echo 'monitoring rejected: production scrape interval must be at least 15s' >&2
      exit 1
    fi
    ;;
  *) echo 'monitoring rejected: profile must be test or production' >&2; exit 1 ;;
esac

case "${APP_TARGET}:${PM2_METRICS_TARGET}:${AWS_REGION}" in
  *[!A-Za-z0-9._:-]*) echo 'monitoring rejected: target or region is invalid' >&2; exit 1 ;;
esac

sed \
  -e "s|\${PROMETHEUS_SCRAPE_INTERVAL}|${PROMETHEUS_SCRAPE_INTERVAL}|g" \
  -e "s|\${APP_TARGET}|${APP_TARGET}|g" \
  -e "s|\${PM2_METRICS_TARGET}|${PM2_METRICS_TARGET}|g" \
  -e "s|\${AWS_REGION}|${AWS_REGION}|g" \
  "${template}" > /etc/prometheus/prometheus.yml

promtool check config /etc/prometheus/prometheus.yml >/dev/null

echo "Starting Prometheus..."
exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml

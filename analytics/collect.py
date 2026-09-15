import os
import csv
import requests
from datetime import datetime, timedelta, timezone
from pathlib import Path

CF_API_TOKEN = os.environ['CF_API_TOKEN']
CF_ACCOUNT_ID = os.environ['CF_ACCOUNT_ID']
CF_SITE_TAG = os.environ['CF_SITE_TAG']
RESEND_API_KEY = os.environ['RESEND_API_KEY']
TO_EMAIL = 'goseongwon9@gmail.com'

KST = timezone(timedelta(hours=9))
now_kst = datetime.now(KST)

target_date_str = os.environ.get('TARGET_DATE', '').strip()
if target_date_str:
    target = datetime.strptime(target_date_str, '%Y-%m-%d').replace(tzinfo=KST)
else:
    target = now_kst - timedelta(days=1)

date_str = target.strftime('%Y-%m-%d')
prev_date_str = (target - timedelta(days=1)).strftime('%Y-%m-%d')
start_utc = target.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
end_utc = target.replace(hour=23, minute=59, second=59, microsecond=0).astimezone(timezone.utc)

CF_HEADERS = {
    'Authorization': f'Bearer {CF_API_TOKEN}',
    'Content-Type': 'application/json'
}
CF_GQL = 'https://api.cloudflare.com/client/v4/graphql'

QUERY_HOURLY = """
query($accountTag: String!, $siteTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      rumPageloadEventsAdaptiveGroups(
        filter: {
          AND: [
            {datetime_geq: $start}
            {datetime_leq: $end}
            {siteTag: $siteTag}
          ]
        }
        limit: 10000
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions {
          datetimeHour
          userAgentBrowser
          deviceType
        }
      }
    }
  }
}
"""

QUERY_COUNTRY = """
query($accountTag: String!, $siteTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      rumPageloadEventsAdaptiveGroups(
        filter: {
          AND: [
            {datetime_geq: $start}
            {datetime_leq: $end}
            {siteTag: $siteTag}
          ]
        }
        limit: 10000
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions {
          countryName
        }
      }
    }
  }
}
"""

def cf_request(query):
    resp = requests.post(CF_GQL, headers=CF_HEADERS, json={
        'query': query,
        'variables': {
            'accountTag': CF_ACCOUNT_ID,
            'siteTag': CF_SITE_TAG,
            'start': start_utc.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'end': end_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
        }
    })
    resp.raise_for_status()
    data = resp.json()
    if data.get('errors'):
        raise Exception(f"GraphQL errors: {data['errors']}")
    return data['data']['viewer']['accounts'][0]['rumPageloadEventsAdaptiveGroups']

def to_kst_hour(dt_str):
    if not dt_str:
        return ''
    dt_utc = datetime.strptime(dt_str, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(KST).strftime('%H')

def save_hourly_csv(rows):
    # datetimeHour 기준으로 집계
    hourly = {}
    for r in rows:
        h = to_kst_hour(r['dimensions'].get('datetimeHour') or '')
        if h:
            if h not in hourly:
                hourly[h] = {'pageviews': 0, 'visits': 0}
            hourly[h]['pageviews'] += r['count']
            hourly[h]['visits'] += r['sum']['visits']

    path = Path('analytics/data') / f'{date_str}-hourly.csv'
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['date', 'hour_kst', 'pageviews', 'visits'])
        writer.writeheader()
        for h in sorted(hourly.keys()):
            writer.writerow({
                'date': date_str,
                'hour_kst': h,
                'pageviews': hourly[h]['pageviews'],
                'visits': hourly[h]['visits']
            })
    print(f"Saved: {path}")
    return hourly

def save_country_csv(rows):
    path = Path('analytics/data') / f'{date_str}-country.csv'
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['date', 'country', 'pageviews', 'visits'])
        writer.writeheader()
        for row in rows:
            writer.writerow({
                'date': date_str,
                'country': row['dimensions'].get('countryName') or 'Unknown',
                'pageviews': row['count'],
                'visits': row['sum']['visits']
            })
    print(f"Saved: {path}")

def read_prev_total():
    path = Path('analytics/data') / f'{prev_date_str}-hourly.csv'
    if not path.exists():
        path = Path('analytics/data') / f'{prev_date_str}.csv'
    if not path.exists():
        return None
    total = 0
    with open(path, 'r', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try:
                total += int(row.get('pageviews', 0) or 0)
            except ValueError:
                pass
    return total

def generate_hourly_svg(hourly):
    W, H = 520, 90
    bar_w = W / 24
    max_val = max((v['pageviews'] for v in hourly.values()), default=1) or 1

    elements = []
    for h in range(24):
        hs = f'{h:02d}'
        val = hourly.get(hs, {}).get('pageviews', 0)
        bh = max(2, int((val / max_val) * (H - 18))) if val > 0 else 0
        x = h * bar_w
        y = H - bh - 16
        is_peak = val > 0 and val == max_val
        color = '#2563eb' if is_peak else '#93c5fd'
        if bh > 0:
            elements.append(
                f'<rect x="{x+1:.1f}" y="{y}" width="{bar_w-2:.1f}" height="{bh}" rx="2" fill="{color}"/>'
            )
        if h % 6 == 0 or h == 23:
            lx = x + bar_w / 2
            elements.append(
                f'<text x="{lx:.1f}" y="{H}" text-anchor="middle" font-size="9" fill="#94a3b8">{h:02d}시</text>'
            )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H+4}" style="display:block">'
        f'<rect width="{W}" height="{H}" rx="6" fill="#f1f5f9"/>'
        + ''.join(elements)
        + '</svg>'
    )

def make_table_rows(items):
    return ''.join(
        f'<tr>'
        f'<td style="padding:5px 8px;color:#374151">{label}</td>'
        f'<td style="padding:5px 8px;text-align:right;font-weight:600;color:#1e293b">{val:,}</td>'
        f'</tr>'
        for label, val in items
    )

COUNTRY_FLAGS = {
    'South Korea': '🇰🇷', 'Korea, Republic of': '🇰🇷',
    'United States': '🇺🇸', 'Japan': '🇯🇵', 'China': '🇨🇳',
    'Germany': '🇩🇪', 'United Kingdom': '🇬🇧', 'France': '🇫🇷',
    'Australia': '🇦🇺', 'Canada': '🇨🇦', 'Singapore': '🇸🇬',
    'Taiwan': '🇹🇼', 'Hong Kong': '🇭🇰', 'Vietnam': '🇻🇳',
}

def flag(c):
    return COUNTRY_FLAGS.get(c, '🌐')

def send_report(hourly_rows, country_rows, raw_rows):
    total_views = sum(v['pageviews'] for v in hourly_rows.values())
    total_visits = sum(v['visits'] for v in hourly_rows.values())
    prev_total = read_prev_total()

    peak_hour = max(hourly_rows.items(), key=lambda x: x[1]['pageviews'])[0] if hourly_rows else '-'

    top_countries = sorted(
        [(r['dimensions'].get('countryName') or 'Unknown', r['count']) for r in country_rows],
        key=lambda x: x[1], reverse=True
    )[:6]

    browser_agg = {}
    device_agg = {}
    for r in raw_rows:
        b = r['dimensions'].get('userAgentBrowser') or 'Unknown'
        d = r['dimensions'].get('deviceType') or 'Unknown'
        browser_agg[b] = browser_agg.get(b, 0) + r['count']
        device_agg[d] = device_agg.get(d, 0) + r['count']
    top_browsers = sorted(browser_agg.items(), key=lambda x: x[1], reverse=True)[:5]
    top_devices = sorted(device_agg.items(), key=lambda x: x[1], reverse=True)

    if prev_total and prev_total > 0:
        diff = total_views - prev_total
        diff_pct = (diff / prev_total) * 100
        sign = '+' if diff >= 0 else ''
        arrow_color = '#16a34a' if diff >= 0 else '#dc2626'
        vs_html = f'<span style="color:{arrow_color};font-size:11px">{"▲" if diff>=0 else "▼"} {abs(diff_pct):.1f}% ({sign}{diff:,} vs 어제 {prev_total:,})</span>'
    else:
        vs_html = '<span style="color:#94a3b8;font-size:11px">어제 데이터 없음</span>'

    svg = generate_hourly_svg(hourly_rows)

    country_section = ''
    if top_countries:
        country_section = f'''
    <div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px">🌍 국가별</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        {make_table_rows([(f"{flag(c)} {c}", v) for c, v in top_countries])}
      </table>
    </div>'''

    html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12)">
  <div style="background:#1e293b;padding:24px;color:#fff">
    <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;letter-spacing:.5px">GUITAR PRICE CHECKER</div>
    <div style="font-size:20px;font-weight:700">{date_str} 일일 리포트</div>
  </div>
  <div style="padding:24px">
    <div style="display:flex;gap:12px;margin-bottom:24px">
      <div style="flex:1;background:#f1f5f9;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#64748b;margin-bottom:6px">페이지뷰</div>
        <div style="font-size:30px;font-weight:700;color:#1e293b;line-height:1">{total_views:,}</div>
        <div style="margin-top:6px">{vs_html}</div>
      </div>
      <div style="flex:1;background:#f1f5f9;border-radius:8px;padding:16px">
        <div style="font-size:11px;color:#64748b;margin-bottom:6px">방문자수</div>
        <div style="font-size:30px;font-weight:700;color:#1e293b;line-height:1">{total_visits:,}</div>
        <div style="margin-top:6px;color:#64748b;font-size:11px">피크 {peak_hour}시 KST</div>
      </div>
    </div>
    <div style="margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px">⏰ 시간별 트래픽 (KST)</div>
      {svg}
    </div>
    {country_section}
    <div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px">📱 기기 유형</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        {make_table_rows(top_devices)}
      </table>
    </div>
    <div>
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px">🌐 브라우저</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        {make_table_rows(top_browsers)}
      </table>
    </div>
  </div>
</div>
</body></html>'''

    resp = requests.post(
        'https://api.resend.com/emails',
        headers={'Authorization': f'Bearer {RESEND_API_KEY}', 'Content-Type': 'application/json'},
        json={
            'from': 'onboarding@resend.dev',
            'to': TO_EMAIL,
            'subject': f'[Guitar Price Checker] {date_str} — {total_views:,} views',
            'html': html
        }
    )
    print(f"Email sent: {resp.status_code}")

hourly_rows_raw = cf_request(QUERY_HOURLY)
print(f"Fetched {len(hourly_rows_raw)} hourly rows")
hourly = save_hourly_csv(hourly_rows_raw)

country_rows = cf_request(QUERY_COUNTRY)
print(f"Fetched {len(country_rows)} country rows")
save_country_csv(country_rows)

send_report(hourly, country_rows, hourly_rows_raw)

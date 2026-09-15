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
start_utc = target.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
end_utc = target.replace(hour=23, minute=59, second=59, microsecond=0).astimezone(timezone.utc)

QUERY = """
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
        orderBy: [datetime_ASC]
      ) {
        count
        sum { visits }
        dimensions {
          datetime
          requestPath
          userAgentBrowser
          deviceType
        }
      }
    }
  }
}
"""

def fetch_analytics():
    resp = requests.post(
        'https://api.cloudflare.com/client/v4/graphql',
        headers={
            'Authorization': f'Bearer {CF_API_TOKEN}',
            'Content-Type': 'application/json'
        },
        json={
            'query': QUERY,
            'variables': {
                'accountTag': CF_ACCOUNT_ID,
                'siteTag': CF_SITE_TAG,
                'start': start_utc.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'end': end_utc.strftime('%Y-%m-%dT%H:%M:%SZ')
            }
        }
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"API response keys: {list(data.keys())}")
    if data.get('errors'):
        raise Exception(f"GraphQL errors: {data['errors']}")
    accounts = data['data']['viewer']['accounts']
    print(f"Accounts found: {len(accounts)}")
    if not accounts:
        raise Exception("No accounts found in response")
    rows = accounts[0]['rumPageloadEventsAdaptiveGroups']
    print(f"Raw rows count: {len(rows)}")
    return rows

def parse_hour_kst(dt_str):
    if not dt_str:
        return ''
    dt_utc = datetime.strptime(dt_str, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    dt_kst = dt_utc.astimezone(KST)
    return dt_kst.strftime('%H')

def save_csv(rows):
    path = Path('analytics/data') / f'{date_str}.csv'
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'date', 'hour_kst', 'datetime_utc', 'path', 'pageviews', 'visits', 'browser', 'device'
        ])
        writer.writeheader()
        for row in rows:
            dt_str = row['dimensions'].get('datetime') or ''
            writer.writerow({
                'date': date_str,
                'hour_kst': parse_hour_kst(dt_str),
                'datetime_utc': dt_str,
                'path': row['dimensions']['requestPath'],
                'pageviews': row['count'],
                'visits': row['sum']['visits'],
                'browser': row['dimensions']['userAgentBrowser'] or '',
                'device': row['dimensions']['deviceType'] or ''
            })
    print(f"Saved: {path}")

def send_report(rows):
    total_views = sum(r['count'] for r in rows)
    total_visits = sum(r['sum']['visits'] for r in rows)

    page_views = {}
    for r in rows:
        p = r['dimensions']['requestPath'] or '/'
        page_views[p] = page_views.get(p, 0) + r['count']
    top_pages = sorted(page_views.items(), key=lambda x: x[1], reverse=True)[:5]

    browser_views = {}
    for r in rows:
        b = r['dimensions']['userAgentBrowser'] or 'Unknown'
        browser_views[b] = browser_views.get(b, 0) + r['count']
    top_browsers = sorted(browser_views.items(), key=lambda x: x[1], reverse=True)[:3]

    hour_views = {}
    for r in rows:
        dt_str = r['dimensions'].get('datetime') or ''
        h = parse_hour_kst(dt_str)
        if h:
            hour_views[h] = hour_views.get(h, 0) + r['count']
    peak_hours = sorted(hour_views.items(), key=lambda x: x[1], reverse=True)[:3]

    lines = [
        f"[Guitar Price Checker] {date_str} 일일 리포트",
        "",
        "📊 요약",
        f"  페이지뷰: {total_views:,}",
        f"  방문자수: {total_visits:,}",
        "",
        "📄 인기 페이지",
    ]
    for page, views in top_pages:
        lines.append(f"  {page}: {views:,}")
    lines += ["", "⏰ 피크 시간대 (KST)"]
    for hour, views in peak_hours:
        lines.append(f"  {hour}시: {views:,}")
    lines += ["", "🌐 브라우저"]
    for browser, views in top_browsers:
        lines.append(f"  {browser}: {views:,}")

    body = "\n".join(lines)

    resp = requests.post(
        'https://api.resend.com/emails',
        headers={
            'Authorization': f'Bearer {RESEND_API_KEY}',
            'Content-Type': 'application/json'
        },
        json={
            'from': 'onboarding@resend.dev',
            'to': TO_EMAIL,
            'subject': f'[Guitar Price Checker] {date_str} 분석 리포트',
            'text': body
        }
    )
    print(f"Email sent: {resp.status_code}")

rows = fetch_analytics()
print(f"Fetched {len(rows)} rows for {date_str}")
save_csv(rows)
send_report(rows)

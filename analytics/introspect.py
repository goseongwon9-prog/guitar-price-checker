import os
import requests

CF_API_TOKEN = os.environ['CF_API_TOKEN']

QUERY = """
{
  __type(name: "AccountRumPageloadEventsAdaptiveGroupsDimensions") {
    name
    fields {
      name
      type { name kind }
    }
  }
}
"""

resp = requests.post(
    'https://api.cloudflare.com/client/v4/graphql',
    headers={
        'Authorization': f'Bearer {CF_API_TOKEN}',
        'Content-Type': 'application/json'
    },
    json={'query': QUERY}
)
data = resp.json()
t = data['data']['__type']
print(f"\n=== {t['name']} fields ===")
for f in sorted(t['fields'], key=lambda x: x['name']):
    print(f"  {f['name']}: {f['type']['name'] or f['type']['kind']}")

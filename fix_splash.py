import json

with open('apps/desktop_host/tauri.conf.json', 'r') as f:
    data = json.load(f)

for win in data['app']['windows']:
    if win['label'] == 'main':
        win['maximized'] = False

with open('apps/desktop_host/tauri.conf.json', 'w') as f:
    json.dump(data, f, indent=4)

print("Fixed tauri.conf.json")

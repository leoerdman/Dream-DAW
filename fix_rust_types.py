import re

log_path = 'cargo_check.log'
with open(log_path, 'r') as f:
    log = f.read()

# Pattern for expected State/&State, found &ProjectState/ProjectState
# We will just parse the file path and line number, and the expected/found types
pattern = re.compile(
    r'-->\s*(apps/desktop_host/src/commands/[^\n]+):(\d+):(\d+)\n'
    r'(?:.|\n)*?'
    r'expected (?:reference |struct )?`(&?tauri::State<\'_, ProjectRegistry>|&?State<\'_, ProjectRegistry>)`,\s*found (?:reference )?`(&?&?project_state::ProjectState|&?&?ProjectState)`',
    re.MULTILINE
)

matches = pattern.findall(log)
files_to_fix = {}

for match in matches:
    path = match[0]
    line = int(match[1])
    col = int(match[2])
    expected = match[3]
    found = match[4]
    
    if path not in files_to_fix:
        files_to_fix[path] = []
    files_to_fix[path].append((line, expected, found))

import sys

for path, fixes in files_to_fix.items():
    print(f"Fixing {path}...")
    try:
        with open(path, 'r') as f:
            lines = f.readlines()
            
        # We process bottom-up to not mess up line numbers if we ever added lines (but we only replace)
        for fix in sorted(fixes, key=lambda x: x[0], reverse=True):
            line_idx = fix[0] - 1
            expected = fix[1]
            found = fix[2]
            
            orig_line = lines[line_idx]
            new_line = orig_line
            
            if '&State' in expected or '&tauri::State' in expected:
                if '&project_state' in orig_line:
                    new_line = orig_line.replace('&project_state', '&project_registry')
                elif '&*project_state' in orig_line:
                    new_line = orig_line.replace('&*project_state', '&project_registry')
            else:
                if 'project_state.clone()' in orig_line:
                    new_line = orig_line.replace('project_state.clone()', 'project_registry.clone()')
                elif 'project_state,' in orig_line:
                    new_line = orig_line.replace('project_state,', 'project_registry.clone(),')
                elif 'project_state' in orig_line: # fallback for end of parens
                    new_line = orig_line.replace('project_state', 'project_registry.clone()')
                    
            if new_line != orig_line:
                print(f"  Line {line_idx+1}: {orig_line.strip()}  ->  {new_line.strip()}")
                lines[line_idx] = new_line
            else:
                print(f"  Line {line_idx+1}: COULD NOT FIX: {orig_line.strip()}")
                
        with open(path, 'w') as f:
            f.writelines(lines)
    except Exception as e:
        print(f"Error processing {path}: {e}")


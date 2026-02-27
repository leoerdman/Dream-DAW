import re

with open('src/commands/sections/clip_mutators/audio_state_commands.rs', 'r') as f:
    content = f.read()

# Pattern: find #[tauri::command] followed by a function definition up to its {
# Then insert the boilerplate right after the {
pattern = re.compile(
    r'(?P<sig>#\[tauri::command\]\s*(?:async\s+)?fn\s+[a-zA-Z0-9_]+\s*\([^)]*\)\s*->\s*Result<[^>]+,\s*String>\s*\{)',
    re.MULTILINE | re.DOTALL
)

boilerplate = """
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;"""

def inject_boilerplate(match):
    sig = match.group('sig')
    # If it already has it, don't inject
    # We will just inject it and let rustc tell us if there's unused variables (which we don't care about)
    return sig + boilerplate

new_content = pattern.sub(inject_boilerplate, content)

# But wait, we saw some unused variables were already there and some functions already had it correctly.
# Let's just do a simpler search and replace for functions that are specifically failing.
# Actually, it's safer to just inject it if `project_state:` is NOT in the first 200 chars after `{`

def smart_inject(match):
    sig = match.group('sig')
    block_start = match.end()
    # Check if project_state is defined soon after
    lookahead = content[block_start:block_start+250]
    if 'let project_state' in lookahead or 'match project_registry.get_active_project()' in lookahead:
        return sig
    return sig + boilerplate

new_content = pattern.sub(smart_inject, content)

with open('src/commands/sections/clip_mutators/audio_state_commands.rs', 'w') as f:
    f.write(new_content)

print("Done")

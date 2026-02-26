import re

files_to_fix_let = [
    'apps/desktop_host/src/commands/sections/track_group_color.rs'
]

for fpath in files_to_fix_let:
    with open(fpath, 'r') as f:
        content = f.read()
    content = content.replace("let project_registry.clone(): &crate::state_managers::ProjectState", "let project_state: &crate::state_managers::ProjectState")
    with open(fpath, 'w') as f:
        f.write(content)

block_to_remove = """    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
"""

files_to_remove_block = [
    'apps/desktop_host/src/commands/sections/clip_mutators/helpers.rs',
    'apps/desktop_host/src/commands/sections/clip_mutators/audio_state_commands.rs'
]

for fpath in files_to_remove_block:
    with open(fpath, 'r') as f:
        content = f.read()
    content = content.replace(block_to_remove, "")
    with open(fpath, 'w') as f:
        f.write(content)

print("Fixed!")

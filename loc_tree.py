import os

# Настройки исключений
EXCLUDE_DIRS = {'.git', 'node_modules', 'target', 'reports', 'docs', 'build', '.idea', '.vscode'}
EXTENSIONS = {'.rs', '.ts', '.tsx', '.js', '.jsx', '.css', '.toml', '.wgsl'}

def count_lines(filepath):
    try:
        with open(filepath, 'rb') as f:
            return sum(1 for _ in f)
    except:
        return 0

def build_tree(start_path):
    tree = {}
    for root, dirs, files in os.walk(start_path):
        # Фильтруем папки
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        
        rel_path = os.path.relpath(root, start_path)
        if rel_path == '.':
            current_level = tree
        else:
            current_level = tree
            for part in rel_path.split(os.sep):
                current_level = current_level.setdefault(part, {'_files': {}, '_loc': 0})
        
        current_level['_files'] = {}
        for f in files:
            if any(f.endswith(ext) for ext in EXTENSIONS):
                full_path = os.path.join(root, f)
                loc = count_lines(full_path)
                current_level['_files'][f] = loc

def calculate_loc(node):
    total = sum(node['_files'].values())
    for key, value in node.items():
        if key != '_files' and key != '_loc':
            total += calculate_loc(value)
    node['_loc'] = total
    return total

def print_tree(node, name, indent="", is_last=True):
    branch = "└── " if is_last else "├── "
    print(f"{indent}{branch}{name:.<50} [{node['_loc']:>6} LOC]")
    
    new_indent = indent + ("    " if is_last else "│   ")
    
    # Сначала папки
    subdirs = [k for k in node.keys() if k not in ('_files', '_loc')]
    subdirs.sort(key=lambda x: node[x]['_loc'], reverse=True)
    
    # Затем файлы
    files = sorted(node['_files'].items(), key=lambda x: x[1], reverse=True)
    
    entries = [(d, node[d]) for d in subdirs] + [(f, loc) for f, loc in files]
    
    for i, entry in enumerate(entries):
        last = (i == len(entries) - 1)
        if isinstance(entry[1], dict): # Это папка
            print_tree(entry[1], entry[0], new_indent, last)
        else: # Это файл
            f_branch = "└── " if last else "├── "
            print(f"{new_indent}{f_branch}{entry[0]:.<46} ({entry[1]:>5} LOC)")

if __name__ == "__main__":
    root_tree = {'_files': {}, '_loc': 0}
    # Заполняем структуру
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel_path = os.path.relpath(root, '.')
        
        parts = [] if rel_path == '.' else rel_path.split(os.sep)
        curr = root_tree
        for p in parts:
            curr = curr.setdefault(p, {'_files': {}, '_loc': 0})
            
        for f in files:
            if any(f.endswith(ext) for ext in EXTENSIONS):
                loc = count_lines(os.path.join(root, f))
                curr['_files'][f] = loc

    calculate_loc(root_tree)
    print("\nCORE ARCHITECTURE LOC TREE:")
    print("=" * 70)
    print_tree(root_tree, "Dream DAW", is_last=True)

def check_braces(filename):
    try:
        with open(filename, 'r') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Error opening file: {e}")
        return

    count = 0
    class_started = False
    
    print(f"Scanning {len(lines)} lines...")

    for i, line in enumerate(lines):
        # Ignore comments
        clean_line = line.split('//')[0]
        
        # Simple heuristic, might fail on sophisticated strings but good enough for code structure
        opens = clean_line.count('{')
        closes = clean_line.count('}')
        
        if "class ArrangementViewController" in line:
            class_started = True
            print(f"Class started at line {i+1}")
            
        if class_started:
            count += opens
            count -= closes

            if count == 0 and (opens > 0 or closes > 0): # Ensure we actually processed braces
                print(f"Class Closed at Line {i+1}: {line.strip()}")
                # Don't return, keep strict count to see if we go negative
    
    print(f"Final count: {count}")

check_braces("/Users/leoerdman/Programming - MAIN FOLDER/Dream DAW/Sources/DreamDAWUI/ArrangementViewController.swift")

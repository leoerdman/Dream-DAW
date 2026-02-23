export function pathBasename(path: string): string {
    return path.split('/').pop() || path;
}

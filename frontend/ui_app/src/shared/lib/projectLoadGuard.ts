let projectLoadDepth = 0;
let projectLoadQueue: Promise<unknown> = Promise.resolve();

function clampDepth(depth: number): number {
    return depth < 0 ? 0 : depth;
}

export function isProjectLoadInFlight(): boolean {
    return projectLoadDepth > 0;
}

export function beginProjectLoad(_scope: string): () => void {
    void _scope;
    projectLoadDepth += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        projectLoadDepth = clampDepth(projectLoadDepth - 1);
    };
}

export async function withProjectLoad<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
        const release = beginProjectLoad(scope);
        try {
            return await operation();
        } finally {
            release();
        }
    };

    const queued = projectLoadQueue.then(run, run);
    projectLoadQueue = queued.then(
        () => undefined,
        () => undefined,
    );
    return queued;
}

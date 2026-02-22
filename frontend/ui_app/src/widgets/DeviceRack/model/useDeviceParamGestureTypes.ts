export type AdaptiveSender = {
    send: (value: number, pushUndoStep: boolean) => void;
    cancel: () => void;
};

export type PendingGestureCommit = {
    source: 'internal' | 'vst';
    trackId: string;
    deviceId: string;
    paramName: string;
    value: number;
    paramIndex?: number;
};

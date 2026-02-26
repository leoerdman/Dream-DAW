import { DawShell } from '@/app/layouts/DawShell';

/**
 * Workspace Page — The single page of the DAW.
 * All layout complexity lives inside DawShell.
 */
export const Workspace = ({ onMounted }: { onMounted?: () => void }) => {
    return <DawShell onMounted={onMounted} />;
};

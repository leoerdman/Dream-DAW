import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { useDeviceRackLogic } from './model/useDeviceRackLogic';
import { DeviceRackAutomationMenu } from './ui/DeviceRackAutomationMenu';
import { DeviceRackContent } from './ui/DeviceRackContent';

interface DeviceRackProps {
    selectedTrackId: string;
    rackExpanded?: boolean;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
}

export const DeviceRack = ({ selectedTrackId, rackExpanded, onDropPluginToTrack }: DeviceRackProps) => {
    const logic = useDeviceRackLogic(selectedTrackId, onDropPluginToTrack);

    return (
        <>
            <DeviceRackContent logic={logic} rackExpanded={rackExpanded} />
            <DeviceRackAutomationMenu selectedTrackId={selectedTrackId} logic={logic} />
        </>
    );
};

import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { useDeviceRackLogic } from './model/useDeviceRackLogic';
import { DeviceRackAutomationMenu } from './ui/DeviceRackAutomationMenu';
import { DeviceRackContent } from './ui/DeviceRackContent';

interface DeviceRackProps {
    selectedTrackId: string;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
}

export const DeviceRack = ({ selectedTrackId, onDropPluginToTrack }: DeviceRackProps) => {
    const logic = useDeviceRackLogic(selectedTrackId, onDropPluginToTrack);

    return (
        <>
            <DeviceRackContent logic={logic} />
            <DeviceRackAutomationMenu selectedTrackId={selectedTrackId} logic={logic} />
        </>
    );
};

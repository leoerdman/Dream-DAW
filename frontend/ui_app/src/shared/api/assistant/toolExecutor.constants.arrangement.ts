export interface ArrangementSectionTemplate {
    name: string;
    startBar: number;
    endBar: number;
}

export const ARRANGEMENT_TEMPLATES: Record<string, ArrangementSectionTemplate[]> = {
    house: [
        { name: 'Intro (Kick Only)', startBar: 0, endBar: 8 },
        { name: 'Build-up (Add Hats + Clap)', startBar: 8, endBar: 16 },
        { name: 'Breakdown (Remove Kick, Add Pads)', startBar: 16, endBar: 24 },
        { name: 'Build-up (Riser + Filter Sweep)', startBar: 24, endBar: 28 },
        { name: 'DROP (Full Energy)', startBar: 28, endBar: 44 },
        { name: 'Breakdown 2 (Strip Back)', startBar: 44, endBar: 52 },
        { name: 'DROP 2 (Full + Variation)', startBar: 52, endBar: 60 },
        { name: 'Outro (Fade Elements)', startBar: 60, endBar: 64 },
    ],
    techno: [
        { name: 'Intro (Ambient Textures)', startBar: 0, endBar: 8 },
        { name: 'Build (Add Kick)', startBar: 8, endBar: 16 },
        { name: 'Main Loop A', startBar: 16, endBar: 32 },
        { name: 'Breakdown (Filter Down)', startBar: 32, endBar: 40 },
        { name: 'Main Loop B (Variation)', startBar: 40, endBar: 56 },
        { name: 'Outro (Dissolve)', startBar: 56, endBar: 64 },
    ],
    dnb: [
        { name: 'Intro', startBar: 0, endBar: 8 },
        { name: 'Build-up', startBar: 8, endBar: 16 },
        { name: 'Drop 1', startBar: 16, endBar: 32 },
        { name: 'Breakdown', startBar: 32, endBar: 40 },
        { name: 'Drop 2', startBar: 40, endBar: 56 },
        { name: 'Outro', startBar: 56, endBar: 64 },
    ],
    hiphop: [
        { name: 'Intro', startBar: 0, endBar: 4 },
        { name: 'Verse 1', startBar: 4, endBar: 20 },
        { name: 'Hook/Chorus', startBar: 20, endBar: 28 },
        { name: 'Verse 2', startBar: 28, endBar: 44 },
        { name: 'Hook/Chorus', startBar: 44, endBar: 52 },
        { name: 'Bridge', startBar: 52, endBar: 56 },
        { name: 'Outro', startBar: 56, endBar: 64 },
    ],
    pop: [
        { name: 'Intro', startBar: 0, endBar: 4 },
        { name: 'Verse 1', startBar: 4, endBar: 12 },
        { name: 'Pre-Chorus', startBar: 12, endBar: 16 },
        { name: 'Chorus', startBar: 16, endBar: 24 },
        { name: 'Verse 2', startBar: 24, endBar: 32 },
        { name: 'Pre-Chorus 2', startBar: 32, endBar: 36 },
        { name: 'Chorus 2', startBar: 36, endBar: 44 },
        { name: 'Bridge', startBar: 44, endBar: 52 },
        { name: 'Final Chorus', startBar: 52, endBar: 60 },
        { name: 'Outro', startBar: 60, endBar: 64 },
    ],
};

export const AUTO_CLEANUP_TRACK_NAME_HINTS = [
    'hat', 'hi-hat', 'hihat',
    'vocal', 'vox', 'shaker',
    'perc', 'clap', 'crash',
    'ride', 'cymbal', 'fx',
    'pad', 'syn', 'lead',
];

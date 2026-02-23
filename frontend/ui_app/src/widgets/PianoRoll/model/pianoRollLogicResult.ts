export function composePianoRollLogicResult<
    TRefs extends object,
    TState extends object,
    TComputed extends object,
    TCallbacks extends object,
    TPassthrough extends object,
>({
    refs,
    state,
    computed,
    callbacks,
    passthrough,
}: {
    refs: TRefs;
    state: TState;
    computed: TComputed;
    callbacks: TCallbacks;
    passthrough: TPassthrough;
}): TRefs & TState & TComputed & TCallbacks & TPassthrough {
    return {
        ...refs,
        ...state,
        ...computed,
        ...callbacks,
        ...passthrough,
    };
}

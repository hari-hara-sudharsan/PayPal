/** Injectable clock so authorization-expiry and challenge-window logic can be tested. */
let offset = 0;
export const now = () => Date.now() + offset;
export const advanceClock = (ms: number) => { offset += ms; };
export const resetClock = () => { offset = 0; };

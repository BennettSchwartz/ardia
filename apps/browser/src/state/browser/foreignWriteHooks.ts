export const uiWriteHooks: { around: (write: () => void) => void } = { around: (write) => write() };

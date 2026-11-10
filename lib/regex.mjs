// Escape a string for literal use inside a RegExp source.
export const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

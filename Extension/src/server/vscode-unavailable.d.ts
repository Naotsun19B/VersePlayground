// Copyright (c) 2026 Naotsun

// tsconfig.server.json resolves 'vscode' to this empty module, so code in src/server and src/shared fails the type
// check when it uses the VS Code API. The language server runs in a plain Node process, where vscode does not exist.
// Listing only node in the types option is not enough, because it does not stop an explicit import from resolving
// to @types/vscode, and a path mapping to a file that does not exist falls back to node_modules.
export {};

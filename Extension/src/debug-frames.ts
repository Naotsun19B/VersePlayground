// Copyright (c) 2026 Naotsun

import * as path from 'node:path';
import type { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Ending of the procedure that the engine generates around every <constructor> function, such as
 * "MakeRandomGenerator_BodyWrapper" for MakeRandomGenerator. It creates the object and then calls the function body,
 * all on the line of the function's definition. It is not code the user wrote, so it is kept out of the call stack.
 */
const CONSTRUCTOR_WRAPPER_SUFFIX = '_BodyWrapper';

/** Returns whether a frame of verse.exe's call stack is the wrapper of a <constructor> function. */
export function isConstructorWrapperFrame(serverFrame: Readonly<DebugProtocol.StackFrame>): boolean {
  return serverFrame.name.endsWith(CONSTRUCTOR_WRAPPER_SUFFIX);
}

/** Reads the frames out of verse.exe's stackTrace response body. */
export function getServerFrames(serverBody: Record<string, unknown>): DebugProtocol.StackFrame[] {
  return (Array.isArray(serverBody.stackFrames) ? serverBody.stackFrames : []) as DebugProtocol.StackFrame[];
}

/**
 * Turns verse.exe's stack frames into DAP frames.
 * - Wrappers of <constructor> functions are left out.
 * - Frames of runtime helpers such as __SpawnReturnImpl__ have a "path" that is not a file, so they lose their source
 *   and are shown dimmed.
 * - Unknown columns become column 1.
 */
export function toClientStackTrace(serverBody: Record<string, unknown>): DebugProtocol.StackTraceResponse['body'] {
  const stackFrames = getServerFrames(serverBody)
    .filter((serverFrame) => !isConstructorWrapperFrame(serverFrame))
    .map((serverFrame): DebugProtocol.StackFrame => {
      const framePath = serverFrame.source?.path;
      const isFile = (framePath !== undefined && /[\\/]/.test(framePath));
      return {
        ...serverFrame,
        column: Math.max(1, serverFrame.column),
        source: (isFile ? { name: path.basename(framePath), path: framePath } : undefined),
        presentationHint: (isFile ? 'normal' : 'subtle'),
      };
    });
  return { stackFrames, totalFrames: stackFrames.length };
}

// Copyright (c) 2026 Naotsun

/**
 * Wire format of the Verse VM socket debugger that verse.exe starts with --wait-for-debugger or --enable-debugger.
 *
 * It resembles the Debug Adapter Protocol but is not the same:
 * - Every message is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON, not a Content-Length header.
 * - A request carries its command name in "type" (for example {"type":"stackTrace"}), and needs both "seq" and
 *   "request_seq". A response echoes the same "type" and "request_seq".
 * - Events carry their name in "type" too, and have no "request_seq".
 * - There is no initialize, launch or attach request. Right after connecting, the client sends a bare 4-byte count
 *   followed by one message: the JSON array of the first breakpoints, each {source:{path}, id, line}. The script starts
 *   running once that array arrives.
 */

/** TCP port that verse.exe's debugger listens on unless the verse.DebuggerPort console variable changes it. */
export const DEBUGGER_PORT = 1963;

/** Largest message the reader accepts. verse.exe has a limit of its own; this one only guards against garbage. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** One breakpoint of the first set, sent before the script starts. */
export interface FirstBreakpoint {
  /** File the breakpoint is in, exactly as verse.exe knows the file. */
  source: {
    /** Absolute path of the file. */
    path: string;
  };

  /** Identifier the debugger uses when it reports the breakpoint later. */
  id: number;

  /** 1-based line. */
  line: number;
}

/** Encodes one message: its length as a 4-byte big-endian number, then the JSON text. */
export function encodeMessage(message: unknown): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(message), 'utf8');
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(jsonBytes.length, 0);
  return Buffer.concat([lengthBytes, jsonBytes]);
}

/**
 * Encodes the handshake that starts a debugging session.
 *
 * @param nextBreakpointId The first id the debugger may give to breakpoints added later, so it never reuses an id that
 * the client already handed out.
 */
export function encodeHandshake(firstBreakpoints: readonly FirstBreakpoint[], nextBreakpointId: number): Buffer {
  const countBytes = Buffer.alloc(4);
  countBytes.writeUInt32BE(nextBreakpointId, 0);
  return Buffer.concat([countBytes, encodeMessage(firstBreakpoints)]);
}

/** Splits the byte stream from the debugger into messages. Bytes may arrive in pieces of any size. */
export class MessageReader {
  // Bytes received but not yet returned as messages.
  private pendingBytes: Buffer = Buffer.alloc(0);

  /**
   * Adds received bytes and returns every message they complete.
   *
   * @throws Error when a message is larger than the reader accepts or is not JSON, since the stream cannot be read
   * past such a message.
   */
  push(chunk: Buffer): unknown[] {
    this.pendingBytes = Buffer.concat([this.pendingBytes, chunk]);
    const completedMessages: unknown[] = [];
    while (this.pendingBytes.length >= 4) {
      const messageLength = this.pendingBytes.readUInt32BE(0);
      if (messageLength > MAX_MESSAGE_BYTES) {
        throw new Error(`The debugger sent a message of ${messageLength} bytes, which is too large.`);
      }

      if (this.pendingBytes.length < 4 + messageLength) {
        break;
      }
      const jsonText = this.pendingBytes.subarray(4, 4 + messageLength).toString('utf8');
      this.pendingBytes = this.pendingBytes.subarray(4 + messageLength);
      completedMessages.push(JSON.parse(jsonText));
    }
    return completedMessages;
  }
}

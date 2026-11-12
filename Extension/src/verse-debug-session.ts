import { execFile } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { BreakpointEvent, DebugSession, Event, InitializedEvent, OutputEvent, TerminatedEvent } from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DEBUGGER_PORT, encodeHandshake, encodeMessage, MessageReader } from './debug-wire.ts';
import type { FirstBreakpoint } from './debug-wire.ts';

/** Launch configuration of a Verse debugging session, after the extension filled in versePath. */
export interface VerseLaunchArguments extends DebugProtocol.LaunchRequestArguments {
  /** The Verse file to debug. */
  program: string;

  /** Arguments passed to Main in Args after the script path. */
  args?: string[];

  /** Working directory of verse.exe. Defaults to the folder of the program. */
  cwd?: string;

  /** verse.exe of the engine checkout. */
  versePath: string;
}

/** How long to keep retrying the connection while verse.exe starts its debug server. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Pause between connection attempts. */
const CONNECT_RETRY_DELAY_MS = 200;

/** How long VS Code may take to open the terminal for verse.exe. */
const RUN_IN_TERMINAL_TIMEOUT_MS = 10_000;

/** Requests passed to verse.exe unchanged apart from moving the command name into "type". */
type ForwardedCommand = 'threads' | 'stackTrace' | 'scopes' | 'variables' | 'continue' | 'next' | 'stepIn' | 'stepOut' |
  'pause';

/** A message from verse.exe's debugger. Responses carry request_seq; events do not. */
interface ServerMessage {
  /** Command name of a response, or event name. */
  type: string;

  /** Sequence number of the request this message answers. */
  request_seq?: number;

  /** False when the request failed. Missing on success. */
  success?: boolean;

  /** Reason of a failure. */
  message?: string;

  /** Payload of the response or event. */
  body?: Record<string, unknown>;
}

/**
 * Debug adapter that translates between VS Code's Debug Adapter Protocol and verse.exe's socket debugger.
 *
 * verse.exe runs in VS Code's integrated terminal so that InputLine can read what the user types. The adapter starts
 * it with --wait-for-debugger, connects to the debugger port, and sends the breakpoints VS Code set during
 * configuration as the first breakpoints, which lets the script start. It keeps no other state: every request after
 * that is forwarded, and every answer is passed back with only the small changes VS Code needs.
 */
export class VerseDebugSession extends DebugSession {
  // Connection to verse.exe's debugger, set once the handshake was sent.
  private socket: net.Socket | undefined;

  // Splits the bytes from the debugger into messages.
  private readonly reader = new MessageReader();

  // Sequence number of the next request sent to the debugger.
  private nextServerSeq = 1;

  // Callbacks waiting for a response from the debugger, by request sequence number.
  private readonly pendingResponses = new Map<number, (serverMessage: ServerMessage) => void>();

  // Breakpoints VS Code set before the connection exists, by file path as VS Code sent it.
  private readonly firstBreakpointsByPath = new Map<string, FirstBreakpoint[]>();

  // Next breakpoint id this adapter hands out; the debugger continues from it after the handshake.
  private nextBreakpointId = 0;

  // Resolves when VS Code sent configurationDone, so every first breakpoint is known.
  private readonly configurationDone: Promise<void>;

  // Resolves configurationDone.
  private markConfigurationDone: () => void = () => undefined;

  // The program path as passed to verse.exe, which is also how verse.exe names the file in breakpoints and frames.
  private programPath = '';

  // Process id of the terminal shell that runs verse.exe, used to stop the program when debugging stops early.
  private terminalProcessId: number | undefined;

  // Whether the program ended or the session reported its end, so it is reported only once.
  private hasTerminated = false;

  constructor() {
    super();
    // verse.exe reports 1-based lines like VS Code, and 0 for columns it does not know.
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
    this.configurationDone = new Promise<void>((resolve) => {
      this.markConfigurationDone = resolve;
    });
  }

  protected override initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: false,
    };
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected override configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): void {
    this.markConfigurationDone();
    this.sendResponse(response);
  }

  protected override async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: DebugProtocol.LaunchRequestArguments,
  ): Promise<void> {
    const launchArguments = args as VerseLaunchArguments;
    this.programPath = launchArguments.program;
    await this.configurationDone;

    try {
      this.terminalProcessId = await this.startInTerminal(launchArguments);
      // verse.exe has no command-line option for the port, so only one Verse debugging session can run at a time.
      const connectedSocket = await connectWithRetry(DEBUGGER_PORT);
      this.attachSocket(connectedSocket);
      connectedSocket.write(encodeHandshake(this.collectFirstBreakpoints(), this.nextBreakpointId));
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 1, `Could not start debugging: ${String(error)}`);
      this.reportTerminated();
    }
  }

  protected override async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    const sourcePath = args.source.path;
    if (sourcePath === undefined) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    const requestedLines = (args.breakpoints ?? []).map((sourceBreakpoint) => sourceBreakpoint.line);
    if (this.socket === undefined) {
      // Before the connection exists the breakpoints are kept and sent with the handshake. The debugger reports
      // the ones that bind to code with breakpointChanged events, which turn them verified.
      const firstBreakpoints = requestedLines.map((line): FirstBreakpoint => ({
        source: { path: sourcePath },
        id: this.nextBreakpointId++,
        line,
      }));
      this.firstBreakpointsByPath.set(sourcePath, firstBreakpoints);
      response.body = {
        breakpoints: firstBreakpoints.map((firstBreakpoint) => ({
          id: firstBreakpoint.id,
          verified: false,
          line: firstBreakpoint.line,
        })),
      };
      this.sendResponse(response);
      return;
    }

    const serverResponse = await this.sendToServer('setBreakpoints', {
      source: { path: this.toServerPath(sourcePath) },
      breakpoints: requestedLines.map((line) => ({ line })),
    });
    if (serverResponse.success === false) {
      this.sendErrorResponse(response, 2, serverResponse.message ?? 'The debugger rejected the breakpoints.');
      return;
    }
    response.body = { breakpoints: (serverResponse.body?.breakpoints ?? []) as DebugProtocol.Breakpoint[] };
    this.sendResponse(response);
  }

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    void this.forward('threads', response, undefined);
  }

  protected override stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments,
  ): void {
    void this.forward('stackTrace', response, args, (body) => toClientStackTrace(body));
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    void this.forward('scopes', response, args);
  }

  protected override variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    void this.forward('variables', response, args);
  }

  protected override continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments,
  ): void {
    void this.forward('continue', response, args, () => ({ allThreadsContinued: true }));
  }

  protected override nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    void this.forward('next', response, args);
  }

  protected override stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    void this.forward('stepIn', response, args);
  }

  protected override stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
  ): void {
    void this.forward('stepOut', response, args);
  }

  protected override pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    void this.forward('pause', response, args);
  }

  protected override disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
  ): void {
    const isProgramRunning = (this.socket !== undefined && !this.hasTerminated);
    if (this.socket !== undefined) {
      // The debugger detaches on this message; without it the program keeps waiting at a breakpoint.
      this.socket.write(encodeMessage({ type: 'disconnect', seq: this.nextServerSeq, request_seq: this.nextServerSeq }));
      this.socket.end();
    }

    // A detached program runs to the end on its own, so stopping the session would leave it running. Ending the
    // terminal's process tree stops it, which is what pressing Stop means.
    if (isProgramRunning && args.terminateDebuggee !== false && this.terminalProcessId !== undefined) {
      execFile('taskkill', ['/PID', String(this.terminalProcessId), '/T', '/F'], () => undefined);
    }
    this.hasTerminated = true;
    this.sendResponse(response);
  }

  /** Asks VS Code to run verse.exe in its integrated terminal and returns the terminal's process id, if known. */
  private startInTerminal(launchArguments: VerseLaunchArguments): Promise<number | undefined> {
    const terminalArguments: DebugProtocol.RunInTerminalRequestArguments = {
      kind: 'integrated',
      title: 'Verse',
      cwd: launchArguments.cwd ?? path.dirname(launchArguments.program),
      args: [launchArguments.versePath, '--wait-for-debugger', launchArguments.program, ...(launchArguments.args ?? [])],
    };
    return new Promise((resolve, reject) => {
      this.runInTerminalRequest(terminalArguments, RUN_IN_TERMINAL_TIMEOUT_MS, (terminalResponse) => {
        if (!terminalResponse.success) {
          reject(new Error(terminalResponse.message ?? 'VS Code could not open a terminal for verse.exe.'));
          return;
        }
        resolve(terminalResponse.body?.shellProcessId ?? terminalResponse.body?.processId);
      });
    });
  }

  /** Starts reading messages from the debugger and reports the end of the program when the connection closes. */
  private attachSocket(connectedSocket: net.Socket): void {
    this.socket = connectedSocket;
    connectedSocket.on('data', (chunk: Buffer) => {
      let serverMessages: unknown[];
      try {
        serverMessages = this.reader.push(chunk);
      } catch (error) {
        this.sendEvent(new OutputEvent(`Verse debugger: ${String(error)}\n`, 'console'));
        connectedSocket.destroy();
        return;
      }

      for (const serverMessage of serverMessages) {
        this.handleServerMessage(serverMessage as ServerMessage);
      }
    });
    // verse.exe closes the connection when the script ends, which is the only end-of-program signal it gives.
    connectedSocket.on('close', () => this.reportTerminated());
    connectedSocket.on('error', () => undefined);
  }

  /** Routes one message from the debugger to the request waiting for it, or turns an event into a DAP event. */
  private handleServerMessage(serverMessage: ServerMessage): void {
    if (serverMessage.request_seq !== undefined) {
      const resolveResponse = this.pendingResponses.get(serverMessage.request_seq);
      if (resolveResponse !== undefined) {
        this.pendingResponses.delete(serverMessage.request_seq);
        resolveResponse(serverMessage);
      }
      return;
    }

    switch (serverMessage.type) {
      case 'stopped': {
        const stoppedBody = serverMessage.body ?? {};
        const hitBreakpointId = stoppedBody.hitBreakpointId;
        this.sendEvent(new Event('stopped', {
          reason: stoppedBody.reason ?? 'pause',
          threadId: stoppedBody.threadId ?? 0,
          hitBreakpointIds: (typeof hitBreakpointId === 'number' ? [hitBreakpointId] : undefined),
        }));
        break;
      }
      case 'breakpointChanged': {
        this.sendEvent(new BreakpointEvent('changed', (serverMessage.body ?? {}) as unknown as DebugProtocol.Breakpoint));
        break;
      }
      default: {
        this.sendEvent(new OutputEvent(`Verse debugger event: ${JSON.stringify(serverMessage)}\n`, 'console'));
        break;
      }
    }
  }

  /** Sends a request to the debugger and passes its answer back to VS Code. */
  private async forward<TResponse extends DebugProtocol.Response>(
    command: ForwardedCommand,
    response: TResponse,
    args: unknown,
    toClientBody: (serverBody: Record<string, unknown>) => unknown = (serverBody) => serverBody,
  ): Promise<void> {
    if (this.socket === undefined) {
      this.sendErrorResponse(response, 3, 'The program is not connected to the debugger.');
      return;
    }

    const serverResponse = await this.sendToServer(command, args);
    if (serverResponse.success === false) {
      this.sendErrorResponse(response, 4, serverResponse.message ?? `The debugger rejected ${command}.`);
      return;
    }
    response.body = toClientBody(serverResponse.body ?? {});
    this.sendResponse(response);
  }

  /** Sends one request in the debugger's format and resolves with its response. */
  private sendToServer(command: string, args: unknown): Promise<ServerMessage> {
    const connectedSocket = this.socket;
    if (connectedSocket === undefined) {
      return Promise.resolve({ type: command, success: false, message: 'Not connected.' });
    }

    const requestSeq = this.nextServerSeq++;
    return new Promise((resolve) => {
      this.pendingResponses.set(requestSeq, resolve);
      const request: Record<string, unknown> = { type: command, seq: requestSeq, request_seq: requestSeq };
      if (args !== undefined) {
        request.arguments = args;
      }
      connectedSocket.write(encodeMessage(request));
    });
  }

  /** Collects the breakpoints set during configuration, naming the program file the way verse.exe names it. */
  private collectFirstBreakpoints(): FirstBreakpoint[] {
    return [...this.firstBreakpointsByPath.values()].flat().map((firstBreakpoint) => ({
      ...firstBreakpoint,
      source: { path: this.toServerPath(firstBreakpoint.source.path) },
    }));
  }

  /**
   * verse.exe compares file names as plain strings, while VS Code may spell the same file with a different drive
   * letter case. The program file is renamed to the exact spelling passed to verse.exe; other files are left alone.
   */
  private toServerPath(clientPath: string): string {
    return (clientPath.toLowerCase() === this.programPath.toLowerCase() ? this.programPath : clientPath);
  }

  /** Tells VS Code that the program ended, once. */
  private reportTerminated(): void {
    if (this.hasTerminated) {
      return;
    }
    this.hasTerminated = true;
    for (const resolveResponse of this.pendingResponses.values()) {
      resolveResponse({ type: 'closed', success: false, message: 'The program ended.' });
    }
    this.pendingResponses.clear();
    this.sendEvent(new TerminatedEvent());
  }
}

/**
 * Turns verse.exe's stack frames into DAP frames. Frames of runtime helpers such as __SpawnReturnImpl__ have a
 * "path" that is not a file, so they lose their source and are shown dimmed, and unknown columns become column 1.
 */
export function toClientStackTrace(serverBody: Record<string, unknown>): DebugProtocol.StackTraceResponse['body'] {
  const serverFrames = (Array.isArray(serverBody.stackFrames) ? serverBody.stackFrames : []) as DebugProtocol.StackFrame[];
  const stackFrames = serverFrames.map((serverFrame): DebugProtocol.StackFrame => {
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

/** Connects to verse.exe's debugger, retrying while the process starts and opens the port. */
async function connectWithRetry(port: number): Promise<net.Socket> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    try {
      return await connectOnce(port);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`verse.exe did not open its debugger on port ${port}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

/** Makes one connection attempt to the loopback address. */
function connectOnce(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attemptSocket = net.createConnection({ host: '127.0.0.1', port }, () => {
      attemptSocket.removeListener('error', reject);
      resolve(attemptSocket);
    });
    attemptSocket.once('error', reject);
  });
}

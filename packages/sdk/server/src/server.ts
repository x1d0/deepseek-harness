/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionListEntry,
  SessionListParams,
  SessionListResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SessionAbortParams,
  SessionAbortResult,
  SessionArchiveParams,
  SessionArchiveResult,
  SessionRenameParams,
  SessionRenameResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  /** Latest live failure not superseded by a subsequently committed terminal. */
  failure: { readonly error: unknown; readonly atOffset: SessionLogOffset } | undefined
}

/**
 * The slice of the deployment's `sessionTitle` service this server writes.
 *
 * Declared structurally for the same reason as {@link SessionQueryReader}: the
 * service is not a declared dependency, so an `sdk-minimal` deployment where
 * `@deepseek-ai/dsh-session-title` is absent still boots — only
 * `session/rename` fails there, with a message naming the missing service.
 */
interface SessionTitleWriter {
  /** Append an explicit user title to one live session and fold the result. */
  rename(session: Session, title: string): { readonly title: string }
}

/**
 * The slice of the deployment's `workspaceRegistry` service this server uses
 * for the registry-global archive set.
 *
 * Declared structurally for the same reason as {@link SessionQueryReader}:
 * `dsh-base` does not mount workspace (it lives in web layers), the sdk app
 * opts in — a deployment without it boots fine, and only `session/archive` /
 * `session/unarchive` explain what is missing while `session/list` simply
 * reports everything as unarchived.
 */
interface WorkspaceArchiveStore {
  /** The registry-global archive set, in archive order. */
  readonly archivedSessionIds: readonly string[]
  /** Add one existing session to the archive set (idempotent). */
  archiveSession(sessionId: SessionId): Promise<void>
  /** Drop one session from the archive set (idempotent). */
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/**
 * The slice of the deployment's `sessionQuery` service this server reads.
 *
 * Declared structurally on purpose: this plugin needs two read methods, and
 * the service lives in the deployment layer (`dsh-base` mounts
 * `session-query-sqlite`). Keeping no package dependency on it lets an
 * `sdk-minimal` deployment boot — only `session/list` and `session/history`
 * fail there, with a message naming the missing service.
 */
interface SessionQueryReader {
  /** Newest-first live-preferred session records. */
  listSessions(): Promise<readonly QuerySessionRecord[]>
  /** One session's complete replay-validated log; rejects for an unknown id. */
  readSession(sessionId: SessionId): Promise<QuerySessionLog>
  /** Latest folded title, or `undefined` when the log has no title event. */
  readTitle(sessionId: SessionId): Promise<{ readonly title: string } | undefined>
}

/** Session identity a query read reports (a structural subset of `SessionHeader`). */
interface QuerySessionRecord {
  readonly header: { readonly id: SessionId; readonly cwd?: string; readonly createdAt: number }
  readonly live: boolean
  readonly persisted: boolean
}

/** One complete session log as a query read reports it. */
interface QuerySessionLog {
  readonly session: { readonly id: SessionId; readonly cwd?: string; readonly createdAt: number }
  readonly events: SessionEvent[]
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

/** Validate one JSON-RPC `limit` field before it reaches a slice. */
function assertPositiveLimit(method: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${method} limit must be a positive safe integer`)
  }
  return value
}

/** Whether a resume failed because no persisted log exists for the id. */
function isSessionNotFound(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'SessionPersistenceNotFoundError' || error.message.endsWith(' not found'))
}

/** Validate one JSON-RPC session id field. */
function assertSessionId(method: string, value: string): SessionId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${method} sessionId must be a non-empty string`)
  }
  return brandString<SessionId>(value)
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  /** Sessions whose agent reported `running` and no `idle` yet — the abort gate. */
  private readonly busy = new Set<string>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const record = this.sessions.get(session.id)
      if (event.type === 'turn/end' && record?.handle.agent.session === session
        && record.failure !== undefined && event.seq >= record.failure.atOffset) {
        record.failure = undefined
      }
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const record = this.sessions.get(agent.session.id)
      if (record?.handle.agent !== agent) return
      record.failure = { error, atOffset: agent.session.seq }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      const sessionId = String(agent.session.id)
      if (status === 'running') this.busy.add(sessionId)
      else this.busy.delete(sessionId)
      this.transport.notify('session.status', { sessionId, status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.initialized = true
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user' },
    })
    // Enqueued work counts as busy immediately: aborting right after a prompt
    // must stop it even before the agent reports `running`.
    this.busy.add(params.sessionId)
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Restore a persisted session and repair its interrupted final turn without sending input.
   * Uses the initialized model route while preserving the stored session identity and directory.
   * Rejects missing, unreadable, or already owned sessions; never creates a replacement.
   * @param params - persisted session identity in the configured persistence store.
   * @returns an empty result after the Agent is ready for prompts.
   */
  async resume(params: SessionResumeParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const sessionId = params.sessionId
    if (this.sessions.has(sessionId) || this.sessionCreations.has(sessionId)) {
      throw new Error(`SDK session is already open or opening: ${sessionId}`)
    }
    await this.openSession(sessionId, true)
    return {}
  }

  /**
   * Wait for an existing owned Agent and its managed descendants to finish.
   * The response follows all Session notifications emitted during the wait.
   * Rejects a live Agent failure that has no subsequent durable terminal.
   * @param params - the SDK-owned session to observe without creating one.
   * @returns an empty result after the root stays idle across the descendant check.
   */
  async wait(params: SessionWaitParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error(`unknown SDK session: ${params.sessionId}`)
    const agent = rec.handle.agent
    const subagents = this.ctx.get('subagents')
    while (true) {
      this.assertLiveAgent(rec, params.sessionId)
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const children = await subagents?.waitForChildren(agent)
      this.assertLiveAgent(rec, params.sessionId)
      if (!children && agent.status === 'idle' && agent.session.seq === idleSeq) {
        if (rec.failure !== undefined) throw rec.failure.error
        return {}
      }
    }
  }

  /**
   * List the runtime's session corpus, newest first.
   *
   * Reads the deployment's `sessionQuery` service: the SDK profile mounts it
   * (`dsh-base`), while `sdk-minimal` does not and gets an explanatory error.
   * @param params - optional working-directory filter and result cap.
   * @returns matching session descriptors, newest first.
   */
  async listSessions(params: SessionListParams): Promise<SessionListResult> {
    this.assertInitialized()
    const query = this.sessionQuery()
    const records = await query.listSessions()
    const matching = params.cwd === undefined ? records : records.filter(record => record.header.cwd === params.cwd)
    const limit = params.limit === undefined ? undefined : assertPositiveLimit('session/list', params.limit)
    const limited = limit === undefined ? matching : matching.slice(0, limit)
    const archived = this.archivedIds()
    const sessions: SessionListEntry[] = []
    for (const record of limited) {
      const title = await query.readTitle(record.header.id)
      sessions.push({
        sessionId: String(record.header.id),
        ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
        createdAt: record.header.createdAt,
        ...title === undefined ? {} : { title: title.title },
        live: record.live,
        persisted: record.persisted,
        archived: archived.has(String(record.header.id)),
      })
    }
    return { sessions }
  }

  /**
   * Read one session's raw persisted log without making it live.
   *
   * The log is returned exactly as recorded (the same event vocabulary the
   * `session.event` notification carries), so a client can render history with
   * the rendering it already has. Pass `limit` to fetch the newest events only.
   * @param params - target session and optional event cap.
   * @returns session identity plus its log events.
   */
  async sessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    this.assertInitialized()
    const query = this.sessionQuery()
    const sessionId = assertSessionId('session/history', params.sessionId)
    const snapshot = await query.readSession(sessionId)
    const all = snapshot.events
    const cap = params.limit === undefined ? undefined : assertPositiveLimit('session/history', params.limit)
    const events = cap === undefined || all.length <= cap ? all : all.slice(all.length - cap)
    const title = await query.readTitle(sessionId)
    return {
      session: {
        sessionId: String(snapshot.session.id),
        ...snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd },
        createdAt: snapshot.session.createdAt,
        ...title === undefined ? {} : { title: title.title },
      },
      events,
      truncated: events.length !== all.length,
    }
  }

  /**
   * Rename one session by appending an explicit user title.
   *
   * The title is durable session-log state (`session/title` with the `user`
   * source, folded by `@deepseek-ai/dsh-session-title`), not a client-local
   * alias, so every front end sees it. A session that is not live here is
   * brought live first: a persisted one is resumed with its recorded origin,
   * and an unknown id is created the
   * same lazy way `session/prompt` creates it. That is what lets a front end
   * rename a fresh session before its first prompt instead of failing "not
   * live".
   * @param params - target session and the raw user title.
   * @returns the accepted, normalized title.
   */
  async renameSession(params: SessionRenameParams): Promise<SessionRenameResult> {
    this.assertInitialized()
    const sessionId = assertSessionId('session/rename', params.sessionId)
    const rec = await this.resolveSessionForRename(sessionId)
    this.assertLiveAgent(rec, sessionId)
    const accepted = this.sessionTitle().rename(rec.handle.agent.session, params.title)
    return { sessionId, title: accepted.title }
  }

  /**
   * Abort one session's running turn.
   *
   * Cancels the current activity with a user cause: the turn closes with a
   * `turn/end` reason of `aborted` on the event stream, and the next prompt
   * starts a fresh turn. Only a session live in this runtime can be aborted —
   * nothing is resumed or created. Aborting an idle session is an idempotent
   * no-op reported as `aborted: false`.
   * @param params - the session whose turn to abort.
   * @returns the id and whether a running turn was actually cancelled.
   */
  async abortSession(params: SessionAbortParams): Promise<SessionAbortResult> {
    this.assertInitialized()
    const sessionId = assertSessionId('session/abort', params.sessionId)
    const rec = this.sessions.get(sessionId)
    if (rec === undefined) {
      throw new Error(
        `session "${sessionId}" is not live in this runtime; only a live session has a turn to abort`,
      )
    }
    const running = this.busy.delete(sessionId)
    if (running) rec.handle.agent.cancel({ kind: 'user' })
    return { sessionId, aborted: running }
  }

  /**
   * Archive one session into the registry-global archive set.
   *
   * Pure visibility: the session keeps its workspace accounting slot and its
   * log is never touched — grouping surfaces (including `session/list`
   * consumers) hide archived ids. The registry only archives sessions that
   * exist (live or persisted), and archiving twice writes nothing.
   * @param params - target session.
   * @returns the id and its membership after the call (`archived: true`).
   */
  async archiveSession(params: SessionArchiveParams): Promise<SessionArchiveResult> {
    this.assertInitialized()
    const sessionId = assertSessionId('session/archive', params.sessionId)
    await this.workspaceArchive().archiveSession(sessionId)
    return { sessionId, archived: true }
  }

  /**
   * Remove one session from the registry-global archive set (idempotent).
   * @param params - target session.
   * @returns the id and its membership after the call (`archived: false`).
   */
  async unarchiveSession(params: SessionArchiveParams): Promise<SessionArchiveResult> {
    this.assertInitialized()
    const sessionId = assertSessionId('session/unarchive', params.sessionId)
    await this.workspaceArchive().unarchiveSession(sessionId)
    return { sessionId, archived: false }
  }

  /**
   * Bring a rename target live without creating a duplicate persisted session.
   *
   * Resume first: it reaches the persisted log and preserves its origin.
   * Only a genuinely absent id falls through
   * to creation, mirroring `session/prompt`'s lazy creation.
   */
  private async resolveSessionForRename(sessionId: string): Promise<SessionRecord> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    try {
      await this.resume({ sessionId })
    } catch (error) {
      if (!isSessionNotFound(error)) throw error
      return await this.getOrCreateSession(sessionId)
    }
    const rec = this.sessions.get(sessionId)
    /* v8 ignore next -- resume stores the record before it returns. */
    if (rec === undefined) throw new Error(`session "${sessionId}" did not become live`)
    return rec
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('SDK server is not initialized')
  }

  /** Write to the deployment's session-title service, or explain what is missing. */
  private sessionTitle(): SessionTitleWriter {
    const service = (this.ctx as unknown as { get(key: string): unknown }).get('sessionTitle')
    if (service === undefined) {
      throw new Error(
        'session/rename requires the sessionTitle service, which this deployment does not mount '
        + '(dsh-base provides it; sdk-minimal does not)',
      )
    }
    return service as SessionTitleWriter
  }

  /** Write to the deployment's workspace-registry archive set, or explain what is missing. */
  private workspaceArchive(): WorkspaceArchiveStore {
    const service = (this.ctx as unknown as { get(key: string): unknown }).get('workspaceRegistry')
    if (service === undefined) {
      throw new Error(
        'session/archive and session/unarchive require the workspaceRegistry service, '
        + 'which this deployment does not mount (the sdk app mounts @deepseek-ai/dsh-workspace; '
        + 'sdk-minimal does not)',
      )
    }
    return service as WorkspaceArchiveStore
  }

  /** Best-effort archive membership: without the registry, everything lists as unarchived. */
  private archivedIds(): ReadonlySet<string> {
    const service = (this.ctx as unknown as { get(key: string): unknown }).get('workspaceRegistry')
    if (service === undefined) return new Set()
    return new Set((service as WorkspaceArchiveStore).archivedSessionIds)
  }

  /** Read the deployment's session corpus service, or explain what is missing. */
  private sessionQuery(): SessionQueryReader {
    // The service is not a declared dependency (see {@link SessionQueryReader}),
    // so it is read through a widened context rather than the typed registry.
    const service = (this.ctx as unknown as { get(key: string): unknown }).get('sessionQuery')
    if (service === undefined) {
      throw new Error(
        'session/list and session/history require the sessionQuery service, which this deployment does not mount '
        + '(dsh-base provides it; sdk-minimal does not)',
      )
    }
    return service as SessionQueryReader
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Read a Session's effective directory, recovering a missing directory to its origin.
   * @param params - target Session; an unknown id creates it.
   * @returns the absolute effective directory.
   */
  async getWorkingDirectory(params: SessionWorkingDirectoryParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.ensure(agent) }
  }

  /**
   * Change a Session's directory and queue its model-visible transition.
   * @param params - target Session and absolute or current-directory-relative path.
   * @returns the validated absolute directory; origin and permissions are unchanged.
   */
  async setWorkingDirectory(params: SessionWorkingDirectorySetParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.set(agent, params.path) }
  }

  private async workingDirectoryAgent(sessionId: string): Promise<Agent> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(sessionId)
    this.assertLiveAgent(rec, sessionId)
    return rec.handle.agent
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * Managed descendants drain before the root Agent handles and adapter are released.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.ctx.get('subagents')?.drainDescendants(records.map(rec => rec.handle.agent))
    } catch (error: unknown) {
      failures.push(error)
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/resume': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new TypeError('session/resume requires a non-empty sessionId string')
        }
        return this.resume({ sessionId })
      }
      case 'session/wait': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string') throw new TypeError('session/wait requires a sessionId string')
        return this.wait({ sessionId })
      }
      case 'session/working-directory/get':
      case 'session/working-directory/set': {
        if (typeof params?.sessionId !== 'string' || params.sessionId.length === 0) {
          throw new TypeError('working-directory requests require a non-empty sessionId')
        }
        if (method === 'session/working-directory/get') {
          return this.getWorkingDirectory({ sessionId: params.sessionId })
        }
        if (typeof params.path !== 'string') throw new TypeError('working-directory set requires a path string')
        return this.setWorkingDirectory({ sessionId: params.sessionId, path: params.path })
      }
      case 'session/list':
        return this.listSessions(params as unknown as SessionListParams)
      case 'session/history':
        return this.sessionHistory(params as unknown as SessionHistoryParams)
      case 'session/rename':
        return this.renameSession(params as unknown as SessionRenameParams)
      case 'session/abort':
        return this.abortSession(params as unknown as SessionAbortParams)
      case 'session/archive':
        return this.archiveSession(params as unknown as SessionArchiveParams)
      case 'session/unarchive':
        return this.unarchiveSession(params as unknown as SessionArchiveParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    return this.openSession(sessionId, false)
  }

  private openSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    const creation = this.createSession(sessionId, resume)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string, resume: boolean): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
    const agentOptions = this.agentOptions()
    const handle = await (resume ? this.ctx.agents.resume({
      resumeSessionId: brandString<SessionId>(sessionId),
      agentOptions,
    }) : this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd: this.cwd },
      agentOptions,
    }))
    const rec: SessionRecord = { handle, failure: undefined }
    this.sessions.set(sessionId, rec)
    return rec
  }

  /** Route and caps every SDK-created or SDK-resumed agent inherits from `initialize`. */
  private agentOptions(): NonNullable<CreateAgentOptions['agentOptions']> {
    return {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}

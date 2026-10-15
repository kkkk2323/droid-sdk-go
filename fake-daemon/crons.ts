// The loops a Fake Daemon keeps: cron records of kind session_prompt, as
// `/loop` and the Loop tool make them, under daemon.*_cron. Nothing fires on
// its own; a test starts from the records it needs. Every change is told as
// daemon.cron.state_changed, as the real Daemon does.
import { randomUUID } from 'node:crypto'
import type { HandlerContext, MethodHandler } from './scenario.js'

export interface CronFixture {
  /** Defaults to a fresh id. */
  id?: string
  sessionId: string
  /** Defaults to /Users/dev/project. */
  sessionCwd?: string
  prompt: string
  /** A 5-field cron expression in UTC. */
  expression: string
  /** Defaults to active. */
  status?: 'active' | 'held' | 'paused' | 'running' | 'error' | 'expired' | 'cancelled'
  holdReason?: string
  nextRunAt?: string
  fireCount?: number
  lastRunAt?: string
  lastError?: string
  /** Defaults to loop_command. */
  source?: 'loop_command' | 'cron_tool'
}

type CronRecord = Record<string, unknown> & {
  id: string
  status: string
  scope: Record<string, unknown> & { sessionId: string }
  schedule: Record<string, unknown>
  payload: Record<string, unknown>
  heldAt?: string
  holdReason?: string
}

const INACTIVE = new Set(['expired', 'cancelled'])

function record(f: CronFixture, now: string): CronRecord {
  return {
    version: 1,
    id: f.id ?? randomUUID(),
    status: f.status ?? 'active',
    source: f.source ?? 'loop_command',
    schedule: {
      expression: f.expression,
      recurring: true,
      ...(f.nextRunAt ? { nextRunAt: f.nextRunAt } : {}),
      timezone: 'UTC',
    },
    stats: {
      fireCount: f.fireCount ?? 0,
      ...(f.lastRunAt ? { lastRunAt: f.lastRunAt } : {}),
      ...(f.lastError ? { lastError: f.lastError } : {}),
    },
    createdAt: now,
    updatedAt: now,
    ...(f.status === 'held' ? { heldAt: now, holdReason: f.holdReason ?? 'daemon-start' } : {}),
    kind: 'session_prompt',
    scope: {
      type: 'session',
      sessionId: f.sessionId,
      sessionCwd: f.sessionCwd ?? '/Users/dev/project',
      storageDir: `/Users/dev/.factory/crons/${f.sessionId}`,
    },
    runPolicy: { whenSessionInactive: 'hold' },
    payload: { type: 'prompt', prompt: f.prompt, target: { type: 'same_session' } },
  }
}

export function cronHandlers(input: { crons?: CronFixture[] }): Record<string, MethodHandler> {
  const created = new Date().toISOString()
  const crons = (input.crons ?? []).map((f) => record(f, created))
  const find = (id: unknown) => crons.find((c) => c.id === id)
  const changed = (
    context: HandlerContext,
    reason: 'created' | 'updated' | 'deleted',
    changes: CronRecord[],
  ) => {
    if (changes.length === 0) return
    context.daemon.notifyDaemon('daemon.cron.state_changed', {
      reason,
      cronIds: changes.map((c) => c.id),
      ...(reason === 'deleted' ? {} : { crons: changes }),
    })
  }
  const update = (c: CronRecord, patch: Partial<CronRecord>) => {
    Object.assign(c, patch, { updatedAt: new Date().toISOString() })
    // A hold's time and reason last only while the record is held.
    if (c.status !== 'held') {
      delete c.heldAt
      delete c.holdReason
    }
  }
  const ofSession = (sessionId: unknown, status: string) =>
    crons.filter((c) => c.scope.sessionId === sessionId && c.status === status)
  return {
    'daemon.list_crons': (params) => ({
      crons: crons.filter(
        (c) =>
          (params['sessionId'] === undefined || c.scope.sessionId === params['sessionId']) &&
          (params['includeInactive'] === true || !INACTIVE.has(c.status)),
      ),
    }),
    'daemon.create_cron': (params, context) => {
      const scope = params['scope'] as { sessionId: string; sessionCwd: string }
      const schedule = params['schedule'] as { expression: string }
      const payload = params['payload'] as { prompt: string }
      const c = record(
        {
          sessionId: scope.sessionId,
          sessionCwd: scope.sessionCwd,
          prompt: payload.prompt,
          expression: schedule.expression,
          source: params['source'] as CronFixture['source'],
        },
        new Date().toISOString(),
      )
      crons.push(c)
      changed(context, 'created', [c])
      return { cron: c }
    },
    'daemon.update_cron': (params, context) => {
      const c = find(params['cronId'])
      if (!c) return { cron: null }
      const schedule = params['schedule'] as { expression: string } | undefined
      const payload = params['payload'] as { prompt?: string } | undefined
      update(c, {
        ...(typeof params['status'] === 'string' ? { status: params['status'] } : {}),
        ...(schedule ? { schedule: { ...c.schedule, expression: schedule.expression } } : {}),
        ...(payload?.prompt ? { payload: { ...c.payload, prompt: payload.prompt } } : {}),
      })
      changed(context, 'updated', [c])
      return { cron: c }
    },
    'daemon.delete_cron': (params, context) => {
      const c = find(params['cronId'])
      if (!c) return { deleted: false }
      crons.splice(crons.indexOf(c), 1)
      changed(context, 'deleted', [c])
      return { deleted: true }
    },
    'daemon.hold_session_crons': (params, context) => {
      const held = ofSession(params['sessionId'], 'active')
      for (const c of held) {
        update(c, {
          status: 'held',
          heldAt: new Date().toISOString(),
          holdReason: String(params['reason']),
        })
      }
      changed(context, 'updated', held)
      return { heldCount: held.length }
    },
    'daemon.resume_session_crons': (params, context) => {
      const resumed = ofSession(params['sessionId'], 'held')
      for (const c of resumed) update(c, { status: 'active' })
      changed(context, 'updated', resumed)
      return { resumedCount: resumed.length }
    },
  }
}

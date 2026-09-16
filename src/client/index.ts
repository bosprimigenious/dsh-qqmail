/**
 * dsh-qqmail — browser half.
 *
 * One visible entry: the 「QQ 邮箱」card in the web settings page
 * (`settings.section` slot), driven by ./QqmailPanel.tsx.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external plugin
 * must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { QqmailPanel } from './QqmailPanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'qqmail',
          order: 338,
          label: () => 'QQ 邮箱',
        },
        QqmailPanel,
      ),
    )
  } catch (error) {
    console.warn('[dsh-qqmail] settings panel registration failed:', error)
  }
}

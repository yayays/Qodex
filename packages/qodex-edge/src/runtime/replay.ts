import type {
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationErrorEvent,
  PendingDeliveryRecord,
} from '../protocol.js';
import { CoreEvents } from '../core-protocol.js';
import type { QodexLogger } from '../logger.js';
import { parseRecoverablePayload } from './utils.js';
import type { RuntimeEventPresenter } from './presenter.js';

export interface RuntimeReplayDeps {
  logger: QodexLogger;
  listPendingDeliveries(): Promise<{ pending: PendingDeliveryRecord[] }>;
  presenter: RuntimeEventPresenter;
}

export class RuntimeDeliveryReplay {
  constructor(private readonly deps: RuntimeReplayDeps) {}

  async recoverPendingDeliveries(): Promise<void> {
    const { pending } = await this.deps.listPendingDeliveries();
    if (pending.length === 0) {
      return;
    }

    let recovered = 0;
    for (const delivery of pending) {
      try {
        await this.replayPendingDelivery(delivery);
        recovered += 1;
      } catch (error) {
        this.deps.logger.warn({ delivery, error }, 'failed to replay pending delivery');
      }
    }

    this.deps.logger.info(
      { pending: pending.length, recovered },
      'processed recoverable qodex deliveries after startup',
    );
  }

  async replayPendingDelivery(delivery: PendingDeliveryRecord): Promise<void> {
    switch (delivery.method) {
      case CoreEvents.completed:
        await this.deps.presenter.handleCompleted(
          parseRecoverablePayload<ConversationCompletedEvent>(delivery),
        );
        return;
      case CoreEvents.error:
        await this.deps.presenter.handleError(
          parseRecoverablePayload<ConversationErrorEvent>(delivery),
        );
        return;
      case CoreEvents.approvalRequested:
        await this.deps.presenter.handleApproval(
          parseRecoverablePayload<ApprovalRequestedEvent>(delivery),
        );
        return;
      default:
        this.deps.logger.warn({ delivery }, 'ignoring unknown recoverable delivery method');
    }
  }
}

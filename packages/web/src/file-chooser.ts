/** Pending native file choosers, private to one attempt and its live page generation. */

import { randomUUID } from 'node:crypto';
import type { BrowserContext, FileChooser, Frame, Page } from 'playwright-core';
import { EngineError, OBSERVED_TEXT_LIMIT, type LocatorAction, type OperationContext, type SemanticNode } from 'e2e/engine';
import { CaptureScope } from './capture-scope.ts';
import { cancelled } from './support.ts';
import { withConnectionBudget } from './operation-budget.ts';

interface PendingChooser {
  readonly identity: string;
  readonly native: FileChooser;
  readonly frame: Promise<Frame | null>;
  ownerFrame?: Frame | null;
}

interface WatchedPage {
  epoch: object;
  pending?: PendingChooser;
  readonly appeared: (chooser: FileChooser) => void;
  readonly navigated: (frame: Frame) => void;
  readonly closed: () => void;
}

/** A native chooser is not a locator or a hidden element promoted into the document tree. */
export interface FileChooserTarget {
  readonly kind: 'filechooser';
  readonly page: Page;
  readonly pending: PendingChooser;
}

export class FileChoosers {
  private context: BrowserContext | undefined;
  private readonly pages = new Map<Page, WatchedPage>();
  private disposed = false;
  private readonly appeared = (page: Page): void => this.watch(page);

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.dispose, { once: true });
    if (signal.aborted) this.dispose();
  }

  /** Registers before app navigation; a reconnect retires all earlier native chooser handles. */
  install(context: BrowserContext): void {
    this.checkOpen();
    this.detach();
    this.context = context;
    context.on('page', this.appeared);
    for (const page of context.pages()) this.watch(page);
  }

  /** One page's chooser epoch, checked again before an observation publishes. */
  token(page: Page): object {
    this.checkOpen();
    const watched = this.pages.get(page);
    if (watched === undefined || page.isClosed()) throw stale();
    return watched.epoch;
  }

  /** A chooser, cancellation or navigation during capture requires a fresh observation. */
  check(page: Page, token: object): void {
    this.checkOpen();
    if (page.isClosed() || this.pages.get(page)?.epoch !== token) throw stale();
  }

  /** Projects only bounded native chooser hints; never the input value, filename or a DOM selector. */
  async capture(page: Page, token: object, mintId: () => string, operation: OperationContext): Promise<{ node: SemanticNode; target: FileChooserTarget } | undefined> {
    this.check(page, token);
    const pending = this.pages.get(page)?.pending;
    if (pending === undefined) return undefined;
    const scope = new CaptureScope(Date.now() + operation.timeoutMs, operation.signal);
    return scope.run(async () => {
      const frame = await scope.read(() => pending.frame);
      this.current(page, pending);
      if (frame === null || frame.isDetached()) {
        this.retire(page, pending);
        throw stale();
      }
      const element = pending.native.element();
      const [accept, directory, disabled, connected] = await scope.read(() => Promise.all([
        element.getAttribute('accept'), element.getAttribute('webkitdirectory'), element.isDisabled(),
        element.evaluate(input => input instanceof HTMLInputElement && input.isConnected && input.type === 'file'),
      ]));
      this.check(page, token);
      this.current(page, pending);
      if (!connected) {
        this.retire(page, pending);
        throw stale();
      }
      return {
        node: {
          ref: { id: mintId(), revision: '' }, role: 'filechooser', name: `File chooser ${pending.identity}`,
          text: directory === null ? 'Choose files for the open file picker.' : 'Directory selection is not supported. Press Escape to cancel.',
          states: { disabled },
          attributes: {
            type: 'file', multiple: String(pending.native.isMultiple()),
            // Omit oversized hints: truncating attributes could expose the prefix of a configured secret.
            ...(accept === null || accept.length <= OBSERVED_TEXT_LIMIT ? { accept: accept ?? '' } : {}),
            ...(directory === null ? {} : { webkitdirectory: 'true' }),
          },
        },
        target: { kind: 'filechooser', page, pending },
      };
    });
  }

  /** Uses only the original native chooser; runner-authorized paths arrive through setInputFiles. */
  async perform(target: FileChooserTarget, page: Page, action: LocatorAction, operation: OperationContext): Promise<void> {
    if (operation.signal.aborted) throw cancelled('file chooser cancelled');
    const { pending } = target;
    if (target.page !== page) throw stale();
    this.current(page, pending);
    if (action.kind === 'press' && action.key === 'Escape') {
      this.cancel(page);
      await page.keyboard.press('Escape');
      return;
    }
    if (action.kind !== 'setInputFiles') throw new EngineError('NOT_ACTIONABLE', 'a file chooser takes upload or Escape', { retryable: false });
    if (!pending.native.isMultiple() && action.paths.length > 1) {
      throw new EngineError('NOT_ACTIONABLE', 'this file chooser takes one file', { retryable: false });
    }
    await withConnectionBudget(operation, 'file chooser upload', async remaining => {
      const element = pending.native.element();
      const frame = await pending.frame;
      remaining();
      const [directory, disabled, connected, multiple] = await Promise.all([
        element.getAttribute('webkitdirectory'), element.isDisabled(),
        element.evaluate(input => input instanceof HTMLInputElement && input.isConnected && input.type === 'file'), element.getAttribute('multiple'),
      ]);
      remaining();
      this.current(page, pending);
      if (frame === null || frame.isDetached() || !connected) {
        this.retire(page, pending);
        throw stale();
      }
      if (directory !== null || disabled || (action.paths.length > 1 && multiple === null)) {
        throw new EngineError('NOT_ACTIONABLE', 'this file chooser cannot take the requested files', { retryable: false });
      }
      const budget = remaining();
      this.retire(page, pending, false);
      try {
        await pending.native.setFiles([...action.paths], { timeout: budget.timeoutMs });
      } finally {
        release(pending);
      }
    });
  }

  /** Escape drops the intercepted chooser without clearing an existing FileList. */
  cancel(page: Page): void {
    const pending = this.pages.get(page)?.pending;
    if (pending !== undefined) this.retire(page, pending);
  }

  /** Retires the attempt before asynchronous browser cleanup or a later callback can run. */
  readonly dispose = (): void => {
    this.disposed = true;
    this.signal.removeEventListener('abort', this.dispose);
    this.detach();
  };

  private checkOpen(): void {
    if (this.signal.aborted) throw cancelled('file chooser cancelled');
    if (this.disposed) throw stale();
  }

  private current(page: Page, pending: PendingChooser): void {
    this.checkOpen();
    if (page.isClosed() || this.pages.get(page)?.pending !== pending) throw stale();
  }

  private retire(page: Page, pending: PendingChooser, dispose = true): void {
    const watched = this.pages.get(page);
    if (watched?.pending === pending) {
      delete watched.pending;
      watched.epoch = {};
    }
    if (dispose) release(pending);
  }

  private watch(page: Page): void {
    if (this.disposed || this.pages.has(page)) return;
    const watched: WatchedPage = {
      epoch: {},
      appeared: native => {
        if (this.disposed || this.pages.get(page) !== watched) return;
        this.cancel(page);
        // Older runners relocate by role/name; a new native picker must never match the old one.
        const pending: PendingChooser = { identity: randomUUID(), native, frame: native.element().ownerFrame().catch(() => null) };
        watched.pending = pending;
        watched.epoch = {};
        void pending.frame.then(frame => { pending.ownerFrame = frame; });
      },
      navigated: frame => {
        const pending = watched.pending;
        if (pending !== undefined && (frame === page.mainFrame() || pending.ownerFrame === undefined || frame === pending.ownerFrame)) this.retire(page, pending);
      },
      closed: () => {
        this.cancel(page);
        this.pages.delete(page);
      },
    };
    this.pages.set(page, watched);
    page.on('filechooser', watched.appeared);
    page.on('framenavigated', watched.navigated);
    page.on('framedetached', watched.navigated);
    page.on('close', watched.closed);
  }

  private detach(): void {
    this.context?.off('page', this.appeared);
    this.context = undefined;
    for (const [page, watched] of this.pages) {
      this.cancel(page);
      page.off('filechooser', watched.appeared);
      page.off('framenavigated', watched.navigated);
      page.off('framedetached', watched.navigated);
      page.off('close', watched.closed);
    }
    this.pages.clear();
  }
}

/** A stale chooser is re-observed, never relocated to another input. */
function stale(): EngineError {
  return new EngineError('NODE_STALE', 'the native file chooser is no longer current; open it again', { retryable: true });
}

/** Native chooser handles live until retirement, not merely until the next observation. */
function release(pending: PendingChooser): void {
  void pending.native.element().dispose().catch(() => undefined);
}

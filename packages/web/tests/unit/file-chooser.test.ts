/** Native chooser ownership around delayed protocol reads and uncertain writes. */

import { EventEmitter } from 'node:events';
import type { BrowserContext, FileChooser, Frame, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { OBSERVED_TEXT_LIMIT } from 'e2e/engine';
import { FileChoosers } from '../../src/file-chooser.ts';

/** A delayed native response whose lifetime the registry must not extend. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A native protocol seam, not a DOM interaction or browser acceptance substitute. */
function protocol() {
  const frame = { isDetached: () => false } as Frame;
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, mainFrame: () => frame, keyboard: { press: vi.fn(async () => undefined) } });
  const context = Object.assign(new EventEmitter(), { pages: () => [page as unknown as Page] });
  const controller = new AbortController();
  const registry = new FileChoosers(controller.signal);
  registry.install(context as unknown as BrowserContext);
  const nativePage = page as unknown as Page;
  const operation = (signal = controller.signal) => ({ signal, timeoutMs: 1_000, runId: 'chooser', attemptId: 'a', origin: 'test' as const });
  const chooser = (options: { frame?: Promise<Frame | null>; accept?: string; directory?: boolean; multiple?: boolean; write?: Promise<void> } = {}) => {
    const dispose = vi.fn(async () => undefined);
    const element = {
      ownerFrame: () => options.frame ?? Promise.resolve(frame),
      getAttribute: async (name: string) => name === 'accept' ? options.accept ?? '.txt' : name === 'webkitdirectory' ? options.directory ? '' : null : name === 'multiple' && options.multiple ? '' : null,
      isDisabled: async () => false, evaluate: async () => true, dispose,
    };
    const setFiles = vi.fn(async () => options.write);
    const native = { element: () => element, isMultiple: () => options.multiple ?? false, setFiles } as unknown as FileChooser;
    page.emit('filechooser', native);
    return { native, setFiles, dispose };
  };
  const capture = () => registry.capture(nativePage, registry.token(nativePage), () => 'opaque-ref', operation());
  return { registry, controller, frame, page, nativePage, chooser, capture, operation };
}

describe('native chooser protocol ownership', () => {
  it('has no ref or counter effect until a native chooser exists, then exposes only bounded hints', async () => {
    const p = protocol();
    try {
      const mint = vi.fn(() => 'opaque');
      expect(await p.registry.capture(p.nativePage, p.registry.token(p.nativePage), mint, p.operation())).toBeUndefined();
      expect(mint).not.toHaveBeenCalled();
      p.chooser({ accept: 'a'.repeat(OBSERVED_TEXT_LIMIT + 1) });
      const result = await p.capture();
      expect(result?.node.attributes).toEqual({ type: 'file', multiple: 'false' });
      expect(result?.node.selector).toBeUndefined();
      expect(result?.node.value).toBeUndefined();
      expect(Object.keys(result!.node)).not.toContain('pending');
    } finally { p.registry.dispose(); }
  });

  it('never publishes a delayed chooser after a superseding native event', async () => {
    const p = protocol(), firstFrame = deferred<Frame | null>();
    try {
      const old = p.chooser({ frame: firstFrame.promise });
      const capturing = expect(p.capture()).rejects.toMatchObject({ code: 'NODE_STALE' });
      const current = p.chooser();
      firstFrame.resolve(p.frame);
      await capturing;
      expect(old.setFiles).not.toHaveBeenCalled();
      expect(old.dispose).toHaveBeenCalledTimes(1);
      const fresh = await p.capture();
      await p.registry.perform(fresh!.target, p.nativePage, { kind: 'setInputFiles', paths: ['approved.txt'] }, p.operation());
      expect(current.setFiles).toHaveBeenCalledTimes(1);
    } finally { p.registry.dispose(); }
  });

  it('gives each native picker a distinct opaque name even for an older runner semantic relocator', async () => {
    const p = protocol();
    try {
      p.chooser();
      const original = await p.capture();
      const same = await p.capture();
      expect(same?.node.name).toBe(original?.node.name);
      p.chooser();
      const replacement = await p.capture();
      expect(replacement?.node.name).not.toBe(original?.node.name);
      expect(replacement?.node.name).toMatch(/^File chooser [a-f0-9-]{36}$/);
    } finally { p.registry.dispose(); }
  });

  it('rejects aborted metadata before a late frame response can publish or upload', async () => {
    const p = protocol(), frame = deferred<Frame | null>();
    const native = p.chooser({ frame: frame.promise });
    const reading = expect(p.capture()).rejects.toMatchObject({ code: 'CANCELLED' });
    p.controller.abort();
    frame.resolve(p.frame);
    await reading;
    expect(native.setFiles).not.toHaveBeenCalled();
    expect(native.dispose).toHaveBeenCalledTimes(1);
  });

  it('retires an uncertain native write so the old chooser cannot be resubmitted', async () => {
    const p = protocol(), write = deferred<void>(), abort = new AbortController();
    try {
      const native = p.chooser({ write: write.promise });
      const observed = await p.capture();
      const writing = expect(p.registry.perform(observed!.target, p.nativePage, { kind: 'setInputFiles', paths: ['approved.txt'] }, p.operation(abort.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect.poll(() => native.setFiles.mock.calls.length).toBe(1);
      abort.abort();
      await writing;
      await expect(p.registry.perform(observed!.target, p.nativePage, { kind: 'setInputFiles', paths: ['another.txt'] }, p.operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      write.resolve();
      await expect.poll(() => native.dispose.mock.calls.length).toBe(1);
      expect(native.setFiles).toHaveBeenCalledTimes(1);
    } finally { write.resolve(); p.registry.dispose(); }
  });

  it('refuses directory selection before native dispatch and Escape only retires the handle', async () => {
    const p = protocol();
    try {
      const native = p.chooser({ directory: true });
      const observed = await p.capture();
      expect(observed?.node.attributes?.['webkitdirectory']).toBe('true');
      await expect(p.registry.perform(observed!.target, p.nativePage, { kind: 'setInputFiles', paths: ['approved.txt'] }, p.operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
      expect(native.setFiles).not.toHaveBeenCalled();
      await p.registry.perform(observed!.target, p.nativePage, { kind: 'press', key: 'Escape' }, p.operation());
      expect(native.setFiles).not.toHaveBeenCalled();
      expect(p.page.keyboard.press).toHaveBeenCalledExactlyOnceWith('Escape');
      expect(native.dispose).toHaveBeenCalledTimes(1);
    } finally { p.registry.dispose(); }
  });

  it('rejects a target on another page and after the original frame navigates', async () => {
    const p = protocol();
    try {
      const native = p.chooser(), observed = await p.capture();
      await expect(p.registry.perform(observed!.target, {} as Page, { kind: 'setInputFiles', paths: ['approved.txt'] }, p.operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      p.page.emit('framenavigated', p.frame);
      await expect(p.registry.perform(observed!.target, p.nativePage, { kind: 'setInputFiles', paths: ['approved.txt'] }, p.operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
      expect(native.setFiles).not.toHaveBeenCalled();
    } finally { p.registry.dispose(); }
  });
});

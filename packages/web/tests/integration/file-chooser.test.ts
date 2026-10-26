/** Native file-chooser events give hidden inputs fresh, observation-owned upload targets. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { decodePng } from '../helpers/png.ts';

/** Finds only the nodes the actual engine observed, including non-DOM chooser nodes. */
function nodes(root: SemanticNode): SemanticNode[] {
  return [root, ...(root.children ?? []).flatMap(nodes)];
}

describe('native file chooser', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-file-chooser-'));
  const file = path.join(projectRoot, 'contract.txt');
  const second = path.join(projectRoot, 'other.txt');
  const signal = new AbortController().signal;
  const operation = () => ({ signal, timeoutMs: 5_000, runId: 'chooser', attemptId: 'chooser', origin: 'test' as const });
  const html = (multiple = false) => `<input id="file" hidden type="file" accept=".txt,text/plain" ${multiple ? 'multiple' : ''}>
    <button onclick="document.getElementById('file').click()">Upload contract</button>
    <button onclick="document.getElementById('file').click()">Choose again</button>
    <p id="result">No file</p><script>
      document.getElementById('file').onchange = async event => {
        document.getElementById('result').textContent = await Promise.all([...event.target.files].map(file => file.text())).then(values => values.join('|'));
      };
    </script>`;
  beforeAll(async () => {
    writeFileSync(file, 'SYNTHETIC_CONTRACT_BYTES');
    writeFileSync(second, 'SYNTHETIC_OTHER_BYTES');
    await surface.init({ runId: 'chooser', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });
  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'chooser', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await (await surface.ensurePage()).setContent(html());
  });
  afterEach(async () => { await surface.endAttempt({ signal, timeoutMs: 5_000 }); });
  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  /** Opens the app's native chooser by tapping its freshly observed button. */
  const choose = async (name = 'Upload contract') => {
    const before = nodes((await surface.observe(operation())).root);
    const button = before.find(node => node.role === 'button' && node.name === name);
    expect(button).toBeDefined();
    const opened = surface.requirePage().waitForEvent('filechooser');
    await surface.perform(button!.ref, { kind: 'tap' }, operation());
    await opened;
    const observed = nodes((await surface.observe(operation())).root);
    const chooser = observed.find(node => node.role === 'filechooser');
    expect(chooser, 'the hidden input must be reachable only through its original native chooser event').toBeDefined();
    return chooser!;
  };

  it('observes the genuine hidden-input chooser and uploads through its fresh ref', async () => {
    expect(nodes((await surface.observe(operation())).root).some(node => node.attributes?.['type'] === 'file')).toBe(false);
    const chooser = await choose();
    expect(chooser.attributes).toMatchObject({ type: 'file', multiple: 'false', accept: '.txt,text/plain' });
    expect(chooser.selector).toBeUndefined();
    expect(chooser.value).toBeUndefined();
    await surface.perform(chooser.ref, { kind: 'setInputFiles', paths: [file] }, operation());
    await expect.poll(() => surface.requirePage().textContent('#result')).toBe('SYNTHETIC_CONTRACT_BYTES');
    expect(nodes((await surface.observe(operation())).root).some(node => node.role === 'filechooser')).toBe(false);
    await expect(surface.perform(chooser.ref, { kind: 'setInputFiles', paths: [second] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('replaces refs on a fresh observation and never reuses a superseded chooser', async () => {
    const old = await choose();
    const fresh = nodes((await surface.observe(operation())).root).find(node => node.role === 'filechooser')!;
    expect(fresh.ref.id).not.toBe(old.ref.id);
    await expect(surface.perform(old.ref, { kind: 'setInputFiles', paths: [file] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    const replacement = await choose('Choose again');
    await expect(surface.perform(fresh.ref, { kind: 'setInputFiles', paths: [file] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await surface.perform(replacement.ref, { kind: 'setInputFiles', paths: [second] }, operation());
    await expect.poll(() => surface.requirePage().textContent('#result')).toBe('SYNTHETIC_OTHER_BYTES');
  });

  it('Escape retires the chooser without clearing the input previous FileList', async () => {
    const page = surface.requirePage();
    await page.locator('#file').setInputFiles(file); // Existing state, not the operation under test.
    const chooser = await choose();
    await surface.pressKey('Escape', operation());
    await expect(surface.perform(chooser.ref, { kind: 'setInputFiles', paths: [second] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(await page.locator('#file').evaluate(element => [...(element as HTMLInputElement).files!].map(selected => selected.name))).toEqual(['contract.txt']);
    expect(nodes((await surface.observe(operation())).root).some(node => node.role === 'filechooser')).toBe(false);
  });

  it('navigation retires a pending chooser before an old ref can mutate the new document', async () => {
    const chooser = await choose();
    await surface.requirePage().goto('about:blank');
    await expect(surface.perform(chooser.ref, { kind: 'setInputFiles', paths: [file] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(nodes((await surface.observe(operation())).root).some(node => node.role === 'filechooser')).toBe(false);
  });

  it('preserves a single chooser after a known no-op refusal and supports native multiple selection', async () => {
    const single = await choose();
    await expect(surface.perform(single.ref, { kind: 'setInputFiles', paths: [file, second] }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    await surface.perform(single.ref, { kind: 'setInputFiles', paths: [file] }, operation());
    await surface.requirePage().setContent(html(true));
    const multiple = await choose();
    expect(multiple.attributes?.['multiple']).toBe('true');
    await surface.perform(multiple.ref, { kind: 'setInputFiles', paths: [file, second] }, operation());
    await expect.poll(() => surface.requirePage().textContent('#result')).toBe('SYNTHETIC_CONTRACT_BYTES|SYNTHETIC_OTHER_BYTES');
  });

  it('never falls back to a matching hidden input after the chooser original element is replaced', async () => {
    const chooser = await choose();
    await surface.requirePage().locator('#file').evaluate(element => {
      const replacement = element.cloneNode() as HTMLInputElement;
      element.replaceWith(replacement);
    });
    await expect(surface.perform(chooser.ref, { kind: 'setInputFiles', paths: [file] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(await surface.requirePage().locator('#file').evaluate(element => (element as HTMLInputElement).files!.length)).toBe(0);
  });

  it('retires a child-frame chooser when that original frame navigates', async () => {
    const page = surface.requirePage();
    await page.setContent('<iframe title="Upload"></iframe>');
    const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
    await frame.setContent(html());
    const opened = page.waitForEvent('filechooser');
    await frame.getByRole('button', { name: 'Upload contract', exact: true }).click();
    await opened;
    const chooser = nodes((await surface.observe(operation())).root).find(node => node.role === 'filechooser');
    expect(chooser).toBeDefined();
    await frame.goto('about:blank');
    await expect(surface.perform(chooser!.ref, { kind: 'setInputFiles', paths: [file] }, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(nodes((await surface.observe(operation())).root).some(node => node.role === 'filechooser')).toBe(false);
  });

  it('keeps secure-field masks while a native chooser is part of the fresh pixel observation', async () => {
    const page = surface.requirePage();
    await page.setContent(html() + '<input id="secure" type="password" value="SYNTHETIC_PASSWORD" style="display:block;background:red;width:180px;height:36px">');
    await choose();
    const snapshot = await surface.observe(operation(), { pixels: true });
    expect(snapshot.pixels).toBeDefined();
    expect(snapshot.maskedRegionCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(snapshot.root)).not.toContain('SYNTHETIC_PASSWORD');
    const box = await page.locator('#secure').boundingBox();
    expect(box).not.toBeNull();
    const image = decodePng(snapshot.pixels!.data);
    expect(image.pixelAt(Math.floor(box!.x + box!.width / 2), Math.floor(box!.y + box!.height / 2))).toEqual([0, 0, 0, 255]);
    const chooser = nodes(snapshot.root).find(node => node.role === 'filechooser');
    expect(chooser).toBeDefined();
    await surface.perform(chooser!.ref, { kind: 'setInputFiles', paths: [file] }, operation());
    await expect.poll(() => page.textContent('#result')).toBe('SYNTHETIC_CONTRACT_BYTES');
  });
});

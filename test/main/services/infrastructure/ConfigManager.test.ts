import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigManager,
  type NotificationTrigger,
} from '../../../../src/main/services/infrastructure/ConfigManager';

const CUSTOM_TRIGGER: NotificationTrigger = {
  id: 'custom-1',
  name: 'Custom',
  enabled: true,
  contentType: 'tool_result',
  mode: 'error_status',
  requireError: true,
  isBuiltin: false,
  color: 'red',
};

describe('ConfigManager', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-manager-'));
    configPath = path.join(tempDir, 'config.json');
  });

  afterEach(() => {
    ConfigManager.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readPersisted(): { notifications: { triggers: NotificationTrigger[] } } {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  it('persists added, updated, and removed triggers', async () => {
    const manager = await ConfigManager.initializeInstance(configPath);

    manager.addTrigger(CUSTOM_TRIGGER);
    expect(manager.getConfig().notifications.triggers.map((t) => t.id)).toContain('custom-1');
    expect(readPersisted().notifications.triggers.map((t) => t.id)).toContain('custom-1');

    manager.updateTrigger('custom-1', { name: 'Renamed' });
    expect(readPersisted().notifications.triggers.find((t) => t.id === 'custom-1')?.name).toBe(
      'Renamed'
    );

    manager.removeTrigger('custom-1');
    expect(readPersisted().notifications.triggers.map((t) => t.id)).not.toContain('custom-1');
    expect(manager.getConfig().notifications.triggers.map((t) => t.id)).not.toContain('custom-1');
  });

  it('writes the config atomically without leaving a temp file behind', async () => {
    const manager = await ConfigManager.initializeInstance(configPath);
    manager.addTrigger(CUSTOM_TRIGGER);

    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
    expect(() => readPersisted()).not.toThrow();
  });

  it('backs up an unparseable config file before falling back to defaults', async () => {
    fs.writeFileSync(configPath, '{ not json', 'utf8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const manager = await ConfigManager.initializeInstance(configPath);

    expect(errorSpy.mock.calls.flat().some((arg) => String(arg).includes('backed it up to'))).toBe(
      true
    );
    errorSpy.mockRestore();

    expect(manager.getConfig().notifications.enabled).toBeDefined();
    const backups = fs.readdirSync(tempDir).filter((f) => f.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, backups[0]), 'utf8')).toBe('{ not json');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

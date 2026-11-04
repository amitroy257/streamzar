import os from 'node:os';
import { app } from 'electron';
import type { SystemStats } from '../../shared/types';

/** System-wide and app CPU / memory usage sampled at a fixed interval. */
export class StatsSampler {
  private prev = os.cpus().map((c) => c.times);
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs: number, cb: (s: SystemStats) => void): void {
    this.stop();
    this.timer = setInterval(() => cb(this.sample()), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sample(): SystemStats {
    const cpus = os.cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    for (let i = 0; i < cpus.length; i++) {
      const a = cpus[i];
      const b = this.prev[i] ?? a;
      const t = a.user - b.user + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
      idle += a.idle - b.idle;
      total += t;
    }
    this.prev = cpus;
    const cpuPercent = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
    let appCpu = 0;
    let memKB = 0;
    for (const m of app.getAppMetrics()) {
      appCpu += m.cpu.percentCPUUsage;
      memKB += m.memory.workingSetSize;
    }
    const cores = Math.max(1, cpus.length);
    return { cpuPercent: Math.round(cpuPercent), appCpuPercent: Math.round(Math.min(100, appCpu / cores)), memoryMB: Math.round(memKB / 1024) };
  }
}
